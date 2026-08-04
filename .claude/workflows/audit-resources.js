export const meta = {
  name: 'audit-resources',
  description:
    'Audit every boom resource handler against the reconcile contract, then adversarially verify each finding',
  whenToUse:
    'Before cutting a release, or after touching src/engine/resources/. Catches a mutating branch that ignores ctx.dryRun and a journal entry written after the write it is supposed to undo.',
  phases: [
    { title: 'Discover', detail: 'list the resource handlers to audit' },
    { title: 'Audit', detail: 'one resource-auditor per handler, in parallel' },
    { title: 'Verify', detail: 'independent skeptics try to refute each finding' },
  ],
}

// The worker is the checked-in `resource-auditor` subagent (.claude/agents/), not an
// inline prompt. One definition, three surfaces: Claude delegates to it directly, a
// teammate can be spawned with `using the resource-auditor agent type`, and this
// workflow drives it via `agentType` below. Changing the contract means editing one file.
const AUDITOR = 'resource-auditor'

// Independent skeptics per finding. A finding survives only if every one of them runs
// AND declines to refute it. Cost scales with findings x VERIFIERS, so this is the dial
// to turn: 1 for a quick look, 3 for a pre-release sweep.
const VERIFIERS = 2

const FILES_SCHEMA = {
  type: 'object',
  required: ['files'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['invariant', 'line', 'summary', 'failure_scenario', 'severity'],
        properties: {
          invariant: {
            type: 'string',
            description:
              'which contract item it breaks: dry-run, journal-order, verb-coverage, clobber, reporting, ownership, output, native',
          },
          line: { type: 'number', description: '1-indexed line the finding anchors to' },
          summary: { type: 'string', description: 'one sentence stating the defect' },
          failure_scenario: {
            type: 'string',
            description: 'concrete inputs or state that reach it, and what goes wrong',
          },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          fix_hint: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: {
      type: 'boolean',
      description: 'true if the finding does not hold. Default to true when uncertain.',
    },
    reason: { type: 'string' },
  },
}

// Basename, for readable agent labels in the /workflows progress view.
function base(path) {
  const parts = String(path).split('/')
  return parts[parts.length - 1] || String(path)
}

function auditPrompt(file) {
  return [
    `Audit the boom resource handler at ${file} against the reconcile contract in your instructions.`,
    '',
    'Read src/engine/types.ts for ReconcileCtx and the Verb union first, and read',
    'src/engine/resources/dir.ts as the known-good worked example before you judge this one.',
    '',
    'Anchor every finding to a specific line in the file above. Rank a reachable dry-run',
    'mutation or a post-write journal entry above everything else. If the handler is clean,',
    'return an empty findings array — that is the expected result for most files.',
  ].join('\n')
}

function refutePrompt(finding, file, lens) {
  // Two distinct lenses beat two identical skeptics: one asks whether the code really does
  // what the finding claims, the other whether the claimed failure is actually reachable.
  const angle =
    lens === 0
      ? 'Re-read the code at and around that line. Does it actually do what the finding claims, or did the auditor misread a guard, a helper, or an early return?'
      : 'Assume the code reads as described. Is the claimed failure genuinely reachable — can a real boomfile and a real ctx get there, or is it dead code or already gated upstream?'

  return [
    `Try to REFUTE this audit finding about ${file}.`,
    '',
    `Invariant: ${finding.invariant}`,
    `Line: ${finding.line}`,
    `Claim: ${finding.summary}`,
    `Claimed failure: ${finding.failure_scenario}`,
    '',
    angle,
    '',
    'Read the file yourself; do not take the claim on trust. Set refuted=true if the finding',
    'does not hold, and default to refuted=true when you are uncertain — a false positive',
    'costs a human the read to disprove it.',
  ].join('\n')
}

// --- Run -----------------------------------------------------------------

phase('Discover')

// `args` scopes the run: pass one or more paths to audit a slice instead of the whole
// directory, e.g. run it on a single handler first to see what it costs before sweeping
// all of them.
const scoped = Array.isArray(args) ? args.map(String).filter(Boolean) : []

const targets = scoped.length
  ? scoped
  : ((
      await agent(
        'List every resource handler under src/engine/resources/. Return the repo-relative path of each .ts file in that directory, excluding any test file.',
        { schema: FILES_SCHEMA, phase: 'Discover', label: 'discover handlers' },
      )
    )?.files ?? [])

if (targets.length === 0) {
  log('No resource handlers found — nothing to audit.')
  return { targets: [], confirmed: [], refuted: 0 }
}

log(
  `${scoped.length ? 'Scoped to' : 'Discovered'} ${targets.length} handler(s); ${VERIFIERS} verifier(s) per finding.`,
)

// Pipeline, not a barrier: a handler's findings go to the skeptics the moment that
// handler's audit lands, so verification of one file overlaps the audit of the next.
const perFile = await pipeline(
  targets,
  (file) =>
    agent(auditPrompt(file), {
      agentType: AUDITOR,
      schema: FINDINGS_SCHEMA,
      label: `audit ${base(file)}`,
      phase: 'Audit',
    }),
  async (audit, file) => {
    // A null audit means the agent was stopped or died after retries — that is not
    // "clean", so surface it rather than letting it read as zero findings.
    if (!audit) return { file, findings: [], errored: true }
    const found = Array.isArray(audit.findings) ? audit.findings : []
    if (found.length === 0) return { file, findings: [], errored: false }

    const judged = await parallel(
      found.map((finding) => () => verify(finding, file)),
    )
    return { file, findings: judged.filter(Boolean), errored: false }
  },
)

async function verify(finding, file) {
  const votes = await parallel(
    Array.from({ length: VERIFIERS }, (_unused, lens) => () =>
      agent(refutePrompt(finding, file, lens), {
        schema: VERDICT_SCHEMA,
        label: `refute ${base(file)}:${finding.line}`,
        phase: 'Verify',
      }),
    ),
  )

  const cast = votes.filter(Boolean)
  // A verifier that never returned is NOT a vote in the finding's favour: require every
  // skeptic to have run and declined to refute. Fewer votes than verifiers = unverified.
  const confirmed = cast.length === VERIFIERS && cast.every((v) => !v.refuted)
  return {
    ...finding,
    file,
    confirmed,
    unverified: cast.length < VERIFIERS,
    refutations: cast.filter((v) => v.refuted).map((v) => v.reason),
  }
}

const rows = perFile.filter(Boolean)
const all = rows.flatMap((r) => r.findings)
const confirmed = all.filter((f) => f.confirmed)
const refuted = all.filter((f) => !f.confirmed && !f.unverified)
const unverified = all.filter((f) => f.unverified)
const errored = rows.filter((r) => r.errored).map((r) => r.file)

const rank = { high: 0, medium: 1, low: 2 }
confirmed.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))

// Say what was dropped. A silent filter reads as "nothing was there".
log(
  `${confirmed.length} confirmed, ${refuted.length} refuted by the skeptics, ${unverified.length} unverified` +
    (errored.length ? `, ${errored.length} handler(s) failed to audit` : ''),
)

return {
  audited: targets.length,
  verifiers: VERIFIERS,
  confirmed,
  refuted_count: refuted.length,
  unverified,
  failed_to_audit: errored,
  clean: rows.filter((r) => !r.errored && r.findings.length === 0).map((r) => r.file),
}
