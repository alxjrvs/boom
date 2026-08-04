# `.claude/` — checked-in agent configuration

Two files, one idea: **the resource contract is written down once, and three different
orchestration surfaces drive it.**

| File | What it is |
| --- | --- |
| `agents/resource-auditor.md` | A read-only subagent that audits one `src/engine/resources/*.ts` handler against the reconcile contract. |
| `workflows/audit-resources.js` | A saved workflow that runs that auditor over every handler in parallel, then has independent skeptics try to refute each finding. |

## Why a subagent and not a prompt

The contract a resource handler has to satisfy — dry-run safety, journal-before-write, verb
coverage, never clobbering a path boom does not own — is the same every time, and it is easy to
get subtly wrong in review. `resource-auditor.md` is that checklist as a definition, so it stops
being something you have to re-describe.

It is declared with `tools: Read, Glob, Grep` and no Bash, Write, or Edit. That is the load-
bearing part: **an auditor that cannot write is one you can point at a file and leave alone.**
It is pinned to `model: sonnet` because a per-file mechanical audit does not need the top tier —
eleven handlers times one agent each adds up.

## One definition, three surfaces

Nothing here is surface-specific, which is the point:

- **As a subagent.** Ask for a handler to be audited and Claude delegates to it, keeping the
  file reads out of the main conversation.
- **As a teammate.** `Spawn a teammate using the resource-auditor agent type to audit
  src/engine/resources/packages.ts` — it honours the same `tools` allowlist and `model`, and the
  body is appended to the teammate's system prompt. Worth knowing: the `skills` and `mcpServers`
  frontmatter fields are *not* applied to teammates, which is why this definition uses neither.
- **As a workflow worker.** `audit-resources.js` passes `agentType: 'resource-auditor'`, so the
  fan-out runs the same checked-in definition rather than an inline prompt that could drift from
  it.

## Running the workflow

```
/audit-resources
```

Scope it first. `args` accepts one or more paths, so you can spend one agent before you spend
eleven:

```
Run /audit-resources on src/engine/resources/dir.ts
```

Two knobs inside the script: `VERIFIERS` (independent skeptics per finding — 1 for a quick
look, 3 for a pre-release sweep) and the `agentType` constant. Cost scales with
findings × `VERIFIERS`, so `VERIFIERS` is the dial that matters.

## What it reports

Findings are only reported after every skeptic has run and declined to refute them. Three
outcomes are kept distinct on purpose, because collapsing them is how an audit lies:

- **confirmed** — survived every verifier, sorted with the high-severity ones first.
- **refuted** — a skeptic disproved it. Counted, not shown.
- **unverified** — a verifier never came back (a stop, or an API error after retries), so the
  finding is neither confirmed nor dismissed. A missing verdict is never treated as agreement.

A handler that fails to audit outright is listed in `failed_to_audit` rather than silently
appearing clean, and the clean handlers are listed by name — an empty findings list is the
expected result for most files, so it has to be distinguishable from "nothing ran."
