export const meta = {
  name: 'brainstorm-time',
  description:
    'Survey boom from many angles, then judge and deepen the survivors into 10 concrete upgrades worth building',
  whenToUse:
    'When you want the next thing to build and not a blank page — planning a release, refreshing docs/directions.md, or deciding what earns the next PR. Every candidate is checked against the north stars and against what already shipped, so the list is arguable rather than generic.',
  phases: [
    { title: 'Survey', detail: 'one scout per lens, each blind to the others' },
    { title: 'Judge', detail: 'impact / north-star / prior-art panel per candidate' },
    { title: 'Deepen', detail: 'the survivors become concrete proposals' },
    { title: 'Synthesize', detail: 'rank them into one brief' },
  ],
}

// How many upgrades to hand back. The whole script is written around "keep going until
// this many survive judging" rather than "generate this many," because a candidate that
// dies to the prior-art veto has to be replaced, not counted.
const TARGET = 10

// Survey rounds are capped: rounds 2+ are told what has already been found and asked for
// genuinely different angles, but a third round rarely says anything new.
const MAX_ROUNDS = 3

// Shared reading list. Every agent gets this — a candidate is only interesting if it is
// non-duplicative, and non-duplicative is only knowable from these four files.
const GROUND = [
  'Read these first, in this order:',
  '  - CLAUDE.md — the north stars and the Don\'ts. Every candidate answers to them.',
  '  - SPEC.md — the design of record.',
  '  - docs/directions.md — upgrades ALREADY on the table. These are prior art, not',
  '    inspiration: do not restate one as if it were new.',
  '  - docs/grander.md — structural changes that already SHIPPED.',
].join('\n')

// The lenses. Each scout searches a different way and is blind to what the others find —
// one angle on a codebase this shape will not surface everything. `product` is the only
// outward-looking one on purpose: the rest can only see what is already here.
const LENSES = [
  {
    key: 'engine',
    focus:
      'The reconcile core: src/engine/reconcile.ts, registry.ts, types.ts, and src/engine/resources/*. Where is the verb-parameterized loop weaker than it looks — a verb a resource type half-supports, a failure mode the per-item boundary reports but cannot undo, a resource type that is missing entirely?',
  },
  {
    key: 'cli',
    focus:
      'The command surface: src/commands/*, src/cli.ts, src/engine/discovery.ts. Ergonomics of the verbs, flags, help/man/completions, and user command discovery. What does a user have to know that the CLI should have told them?',
  },
  {
    key: 'state',
    focus:
      'Durability and recovery: src/engine/db.ts, journal.ts, state.ts, rollback.ts, lock.ts, and the backups directory. What can a half-finished mutating run leave behind that boom cannot then explain or undo?',
  },
  {
    key: 'simplify',
    focus:
      'North star #1, native over special: custom code a Bun or stock-tool built-in could DELETE. Hunt for hand-rolled helpers that Bun.$, Bun.spawn, node:fs, Bun.color, Bun.file, bun:sqlite, or a stock CLI already does. Deleting code in favour of a built-in is explicitly the highest-value change here, so a credible deletion outranks a feature.',
  },
  {
    key: 'dx',
    focus:
      'Time-to-first-run and failure legibility: install, boom init/adopt/source, upgrade, and what every error message actually tells a stuck user. Where does someone bounce off, and where does a failure read as a mystery?',
  },
  {
    key: 'testing',
    focus:
      'The test suite and CI (.github/workflows/, *.test.ts). What is untested that would actually bite — a mutating path, a dry-run guard, Linux-vs-macOS divergence, the compiled-binary smoke path? Name the specific scenario, not "more coverage".',
  },
  {
    key: 'docs',
    focus:
      'The documented surface: README.md, SPEC.md, docs/, and site/ (index.html + build.ts). Look for drift between what the code does and what the docs claim, and for lockstep the project has to remember by hand today (the version in package.json / Formula/boom.rb / the site footer) that could be enforced instead.',
  },
  {
    key: 'product',
    focus:
      'The job to be done, looking outward. Compare against how people actually converge a dev machine today — nix/home-manager, chezmoi, brew bundle, Ansible, dotfile bootstrap scripts. What can they do for a user that boom cannot, that boom could do in ITS idiom (one binary, typed TOML, drift + rollback) rather than by imitation?',
  },
]

// Three distinct judges per candidate, not three identical ones. `prior_art` holds a veto
// because the single most likely failure of a brainstorm is confidently proposing something
// that already exists.
const JUDGES = [
  {
    key: 'impact',
    ask: 'Judge IMPACT only. Would a real person running boom on a real machine notice this, and how often? Ignore how hard it is. Be harsh on anything that is merely tidy.',
  },
  {
    key: 'north-star',
    ask: 'Judge NORTH-STAR FIT only. Score against CLAUDE.md: native over special; one binary with zero runtime deps on the user\'s machine; legible showpiece; one model, two surfaces. Then check the Don\'ts explicitly — set keep=false if it adds a runtime dependency, hardcodes a subcommand case instead of using the route map or command discovery, reaches for bash in the core reconcile path, or lets sync/verify/repair/uninstall drift into separate code paths.',
  },
  {
    key: 'prior-art',
    ask: 'Judge PRIOR ART only, and do it by reading, not from memory. Does this already exist in the codebase (grep for it — check src/commands/ and src/engine/ for the verb or flag it proposes)? Is it already an entry in docs/directions.md, or already shipped per docs/grander.md? Set exists=true and name the file or heading if so. Only score effort once you are satisfied it does not already exist.',
  },
]

const CANDIDATES_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'kind', 'pitch', 'why_now', 'files'],
        properties: {
          title: {
            type: 'string',
            description: 'imperative and specific, e.g. "boom verify --json for CI" — not a theme',
          },
          kind: {
            type: 'string',
            enum: [
              'feature',
              'simplification',
              'robustness',
              'architecture',
              'dx',
              'performance',
              'testing',
              'docs',
            ],
          },
          pitch: { type: 'string', description: 'two or three sentences: what changes, concretely' },
          why_now: {
            type: 'string',
            description: 'what in the code today makes this worth doing — cite a file',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'repo-relative paths it would touch',
          },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['keep', 'score', 'reason'],
  properties: {
    keep: { type: 'boolean', description: 'false if this is not worth the repo\'s time' },
    score: { type: 'number', description: '1-5 on your lens only. 3 is unremarkable.' },
    effort: { type: 'number', description: '1-5, where 1 is an afternoon and 5 is a release arc' },
    exists: {
      type: 'boolean',
      description: 'prior-art lens only: true if this already ships or is already on the table',
    },
    prior_art: { type: 'string', description: 'the file, command, or heading that already covers it' },
    reason: { type: 'string' },
  },
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  required: ['title', 'summary', 'change_plan', 'files', 'effort', 'risks', 'acceptance'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: 'the pitch, tightened, in three sentences or fewer' },
    north_star: { type: 'string', description: 'which north star it serves, and how' },
    change_plan: {
      type: 'array',
      items: { type: 'string' },
      description: 'ordered steps a single PR-sized change would take',
    },
    files: { type: 'array', items: { type: 'string' } },
    effort: { type: 'string', enum: ['S', 'M', 'L'] },
    risks: { type: 'array', items: { type: 'string' } },
    acceptance: {
      type: 'array',
      items: { type: 'string' },
      description: 'how you would know it landed — a test, a command and its output',
    },
    open_question: { type: 'string', description: 'the call a human should make, if there is one' },
  },
}

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['brief', 'order'],
  properties: {
    brief: { type: 'string', description: 'markdown, the whole readable writeup' },
    order: {
      type: 'array',
      items: { type: 'string' },
      description: 'the titles, best-first',
    },
    do_first: { type: 'string', description: 'the one to start with, and why' },
  },
}

// --- Inputs ---------------------------------------------------------------

// `args` is deliberately forgiving: a number scopes the count, a string scopes the theme,
// an object does either or both.
const raw = args
const asObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
const focus =
  typeof raw === 'string' ? raw : typeof asObject.focus === 'string' ? asObject.focus : ''
const wanted = Number(typeof raw === 'number' ? raw : asObject.count) || TARGET
const maxRounds = Number(asObject.rounds) || MAX_ROUNDS

// A focus narrows what each lens looks FOR, never which lenses run — dropping lenses is
// how a scoped brainstorm turns into an echo of the scope.
const lenses = LENSES

function key(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function surveyPrompt(lens, round, seen) {
  const lines = [
    `You are scouting the boom repo for upgrades worth building, through ONE lens.`,
    '',
    GROUND,
    '',
    `Your lens — ${lens.key}:`,
    lens.focus,
  ]

  if (focus) {
    lines.push(
      '',
      `Extra scoping from the person asking: ${focus}`,
      'Apply that through your lens; do not abandon your lens for it.',
    )
  }

  lines.push(
    '',
    'Read actual code before proposing anything. Every candidate must cite a file that made',
    'you think of it. Propose 3 to 5 candidates — a specific, buildable change each, sized',
    'like one or two PRs, not a theme or a direction. "Improve error handling" is not a',
    'candidate; "boom sync reports which resource failed and the boomfile line that declared',
    'it" is.',
    '',
    'Do not propose anything already in docs/directions.md or already shipped. That list is',
    'the bar to clear, not a menu.',
  )

  if (round > 0 && seen.length) {
    lines.push(
      '',
      `This is round ${round + 1}. These have ALREADY been proposed — every one of them is`,
      'off the table, and so is any close paraphrase:',
      ...seen.map((t) => `  - ${t}`),
      '',
      'Find genuinely different ground. Go somewhere in the repo the earlier rounds did not',
      'read, or take the smaller, sharper version of a problem instead of the obvious one.',
    )
  }

  return lines.join('\n')
}

function judgePrompt(candidate, judge) {
  return [
    `Judge one proposed upgrade to the boom repo, through ONE lens.`,
    '',
    GROUND,
    '',
    `Candidate: ${candidate.title}`,
    `Kind: ${candidate.kind}`,
    `Pitch: ${candidate.pitch}`,
    `Why now: ${candidate.why_now}`,
    `Files it names: ${(candidate.files || []).join(', ') || '(none given)'}`,
    '',
    `Your lens — ${judge.key}:`,
    judge.ask,
    '',
    'Read the repo to check the claim; do not take the pitch on trust. Score your lens only,',
    'and be willing to give a 2 — if everything scores 4 the ranking carries no information.',
  ].join('\n')
}

function deepenPrompt(candidate, verdicts) {
  const notes = verdicts.map((v) => `  - ${v.key}: ${v.reason}`).join('\n')
  return [
    `Turn this surviving candidate into a proposal someone could pick up and build.`,
    '',
    GROUND,
    '',
    `Candidate: ${candidate.title}`,
    `Pitch: ${candidate.pitch}`,
    `Why now: ${candidate.why_now}`,
    '',
    'What the judges said:',
    notes,
    '',
    'Read every file this would touch before writing the plan — the change_plan must match',
    'the code that is actually there, naming real functions and real call sites. Keep it to',
    'one PR-sized change if you honestly can, and say so if you cannot. Address the judges\'',
    'reservations rather than restating the pitch. Acceptance criteria must be checkable:',
    'a bun test, or a command and the output it should produce.',
  ].join('\n')
}

// --- Run -----------------------------------------------------------------

log(
  `Brainstorming ${wanted} upgrade(s) across ${lenses.length} lenses` +
    (focus ? `, scoped to: ${focus}` : '') +
    `. Up to ${maxRounds} survey round(s).`,
)

const seenKeys = new Set()
const seenTitles = []
const survivors = []
const vetoed = []
const rejected = []
let rounds = 0

while (survivors.length < wanted && rounds < maxRounds) {
  phase('Survey')

  // Barrier, and a justified one: dedup needs every lens's candidates from this round at
  // once, and judging is the expensive stage — paying three judges for a duplicate is the
  // waste worth a wait here.
  const swept = await parallel(
    lenses.map((lens) => () =>
      agent(surveyPrompt(lens, rounds, seenTitles), {
        schema: CANDIDATES_SCHEMA,
        label: `survey ${lens.key}${rounds ? ` r${rounds + 1}` : ''}`,
        phase: 'Survey',
      }),
    ),
  )

  const fresh = []
  for (const result of swept.filter(Boolean)) {
    for (const candidate of result.candidates || []) {
      const k = key(candidate.title)
      if (!k || seenKeys.has(k)) continue
      seenKeys.add(k)
      seenTitles.push(candidate.title)
      fresh.push(candidate)
    }
  }

  rounds += 1

  if (fresh.length === 0) {
    log(`Round ${rounds} surfaced nothing new — stopping the survey.`)
    break
  }

  log(`Round ${rounds}: ${fresh.length} new candidate(s) after dedup. Judging.`)

  phase('Judge')

  const judged = await parallel(
    fresh.map((candidate) => () =>
      parallel(
        JUDGES.map((judge) => () =>
          agent(judgePrompt(candidate, judge), {
            schema: VERDICT_SCHEMA,
            label: `${judge.key}: ${candidate.title.slice(0, 40)}`,
            phase: 'Judge',
          }).then((v) => (v ? { ...v, key: judge.key } : null)),
        ),
      ).then((votes) => ({ candidate, votes: votes.filter(Boolean) })),
    ),
  )

  for (const row of judged.filter(Boolean)) {
    const { candidate, votes } = row
    if (votes.length < JUDGES.length) {
      // A judge that never returned is not a vote in the candidate's favour.
      rejected.push({ ...candidate, why: 'a judge did not return — unverified' })
      continue
    }

    const priorArt = votes.find((v) => v.key === 'prior-art')
    if (priorArt?.exists) {
      // The veto: already shipped, or already on the table. Kept visible rather than
      // silently dropped — "boom already does this" is itself useful output.
      vetoed.push({ ...candidate, prior_art: priorArt.prior_art || priorArt.reason })
      continue
    }

    if (votes.filter((v) => v.keep).length < 2) {
      rejected.push({ ...candidate, why: votes.find((v) => !v.keep)?.reason || 'judges declined' })
      continue
    }

    const mean = (pick) => {
      const nums = votes.map(pick).filter((n) => typeof n === 'number')
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 3
    }
    const impact = votes.find((v) => v.key === 'impact')?.score ?? mean((v) => v.score)
    const fit = votes.find((v) => v.key === 'north-star')?.score ?? mean((v) => v.score)
    const effort = mean((v) => v.effort)

    survivors.push({
      ...candidate,
      impact,
      fit,
      effort_score: effort,
      // Impact leads, north-star fit is the tiebreak that keeps this repo itself, and
      // effort is a discount rather than a gate — a large change can still win.
      score: impact * 2 + fit * 1.5 - effort,
      verdicts: votes.map((v) => ({ key: v.key, score: v.score, reason: v.reason })),
    })
  }

  log(
    `After ${rounds} round(s): ${survivors.length}/${wanted} survivors, ` +
      `${vetoed.length} vetoed as prior art, ${rejected.length} judged out.`,
  )
}

if (survivors.length === 0) {
  log('Nothing survived judging. The vetoed list below is the real answer.')
  return { requested: wanted, rounds, proposals: [], vetoed, rejected }
}

survivors.sort((a, b) => b.score - a.score)

const shortlist = survivors.slice(0, wanted)
if (survivors.length > wanted) {
  log(`Ranked out ${survivors.length - wanted} survivor(s) below the top ${wanted}.`)
}
if (shortlist.length < wanted) {
  log(`Only ${shortlist.length} candidate(s) cleared the bar — reporting those rather than padding.`)
}

phase('Deepen')

// Barrier: the brief has to rank all of them against each other, so it genuinely needs
// every proposal in hand.
const proposals = (
  await parallel(
    shortlist.map((candidate) => () =>
      agent(deepenPrompt(candidate, candidate.verdicts), {
        schema: PROPOSAL_SCHEMA,
        label: `deepen ${candidate.title.slice(0, 40)}`,
        phase: 'Deepen',
      }).then((p) => (p ? { ...p, score: candidate.score, kind: candidate.kind } : null)),
    ),
  )
).filter(Boolean)

if (proposals.length < shortlist.length) {
  log(`${shortlist.length - proposals.length} proposal(s) failed to deepen and were dropped.`)
}

phase('Synthesize')

const brief = await agent(
  [
    `Write the brief for these ${proposals.length} proposed upgrades to boom.`,
    '',
    GROUND,
    '',
    'The proposals, already judged and researched:',
    '',
    JSON.stringify(proposals, null, 2),
    '',
    'Rank them best-first by what you would actually build next, and say why the order is',
    'what it is. You may disagree with the incoming scores — say so if you do. Note any two',
    'that overlap or that should be sequenced together.',
    '',
    'Output markdown: a one-paragraph read of the shape of the list, then one section per',
    'proposal (title, what it is, why it earns the slot, effort, first file to open), then a',
    'closing line naming the one to start with. Match the voice of docs/directions.md — this',
    'list is meant to be argued with. No preamble about being an AI or about the process.',
  ].join('\n'),
  { schema: BRIEF_SCHEMA, label: 'write the brief', phase: 'Synthesize' },
)

return {
  requested: wanted,
  delivered: proposals.length,
  rounds,
  brief: brief?.brief ?? null,
  do_first: brief?.do_first ?? null,
  order: brief?.order ?? proposals.map((p) => p.title),
  proposals,
  // Kept, not swallowed: "already exists" and "judged out" are both answers.
  vetoed_as_prior_art: vetoed,
  judged_out: rejected.length,
  also_ranked: survivors.slice(wanted).map((s) => s.title),
}
