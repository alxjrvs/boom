# `.claude/` — checked-in agent configuration

Three files, two jobs: **auditing the code that exists**, and **deciding what to build next**.
Both are written down once, in the repo, so they stop being something you re-describe from
scratch each time.

| File | What it is |
| --- | --- |
| `agents/resource-auditor.md` | A read-only subagent that audits one `src/engine/resources/*.ts` handler against the reconcile contract. |
| `workflows/audit-resources.js` | A saved workflow that runs that auditor over every handler in parallel, then has independent skeptics try to refute each finding. |
| `workflows/brainstorm-time.js` | A saved workflow that surveys the repo through eight blind lenses, judges every candidate against the north stars *and* against what already shipped, then deepens the survivors into buildable proposals. |

Both workflows are built the same way, because the same thing goes wrong in both: a plausible
claim that nobody checked. `audit-resources` answers it with skeptics who try to refute each
finding; `brainstorm-time` answers it with a prior-art judge that holds a veto. Neither collapses
"disproved" into "nothing found."

## `audit-resources` — checking the code that exists

### Why a subagent and not a prompt

The contract a resource handler has to satisfy — dry-run safety, journal-before-write, verb
coverage, never clobbering a path boom does not own — is the same every time, and it is easy to
get subtly wrong in review. `resource-auditor.md` is that checklist as a definition, so it stops
being something you have to re-describe.

It is declared with `tools: Read, Glob, Grep` and no Bash, Write, or Edit. That is the load-
bearing part: **an auditor that cannot write is one you can point at a file and leave alone.**
It is pinned to `model: sonnet` because a per-file mechanical audit does not need the top tier —
eleven handlers times one agent each adds up.

### One definition, three surfaces

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

### Running the audit

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

### What it reports

Findings are only reported after every skeptic has run and declined to refute them. Three
outcomes are kept distinct on purpose, because collapsing them is how an audit lies:

- **confirmed** — survived every verifier, sorted with the high-severity ones first.
- **refuted** — a skeptic disproved it. Counted, not shown.
- **unverified** — a verifier never came back (a stop, or an API error after retries), so the
  finding is neither confirmed nor dismissed. A missing verdict is never treated as agreement.

A handler that fails to audit outright is listed in `failed_to_audit` rather than silently
appearing clean, and the clean handlers are listed by name — an empty findings list is the
expected result for most files, so it has to be distinguishable from "nothing ran."

## `brainstorm-time` — deciding what to build next

```
/brainstorm-time
```

Hands back ten upgrades worth building, each one a specific change with a plan, the files it
touches, risks, and how you would know it landed. It is the repeatable version of
[`docs/directions.md`](../docs/directions.md) — which is the same artifact, written by hand, and
therefore already stale the moment something ships.

### The shape

Four phases, and the middle two are where the value is:

1. **Survey** — eight scouts, one per lens (`engine`, `cli`, `state`, `simplify`, `dx`,
   `testing`, `docs`, `product`), each blind to the others. One angle does not find everything:
   the `simplify` lens hunts custom code a Bun built-in could delete, and `product` is the only
   outward-looking one, comparing against nix/chezmoi/`brew bundle`/Ansible. Every candidate has
   to cite the file that prompted it.
2. **Judge** — three *different* judges per candidate, not three identical ones:
   - **impact** — would a real person on a real machine notice, and how often.
   - **north-star** — scored against `CLAUDE.md`, and it fails a candidate outright for
     breaking a **Don't** (a new runtime dep, a hardcoded subcommand case, bash in the core
     reconcile path, the four verbs drifting apart).
   - **prior-art** — **holds a veto.** It greps the repo and re-reads `docs/directions.md` and
     `docs/grander.md`, because the single most likely way a brainstorm fails is proposing,
     confidently, something that already ships.
3. **Deepen** — survivors become PR-sized proposals, written against the code that is actually
   there and answering the judges' reservations rather than restating the pitch.
4. **Synthesize** — one brief, ranked, in the voice of `directions.md`, ending on the one to
   start with.

Rounds loop until ten survive (`MAX_ROUNDS` caps it at three). Round two tells the scouts every
title already proposed and sends them somewhere else in the repo, so a veto costs a *replacement*
rather than a hole in the list.

### Scoping it

`args` is forgiving — a number, a theme, or both:

```
Run /brainstorm-time with args 5
Run /brainstorm-time on "things that would make a first run less scary"
Run /brainstorm-time with args {"count": 6, "focus": "the site and the docs", "rounds": 1}
```

A `focus` narrows what each lens looks *for*, never which lenses run. Dropping lenses is how a
scoped brainstorm turns into an echo of the scope.

### What it reports

`proposals` is the deliverable and `brief` is the readable version of it. Three other fields
exist so the run cannot overstate itself:

- **`vetoed_as_prior_art`** — proposed, then found to already exist, with the file or heading
  that covers it. Surfaced rather than dropped: "boom already does this" is an answer.
- **`also_ranked`** — survived judging but placed below the cut. Nothing is silently truncated.
- **`delivered`** vs **`requested`** — if fewer than ten cleared the bar, it says so instead of
  padding the list.

The knobs are `TARGET` (how many to deliver), `MAX_ROUNDS`, and the `LENSES` / `JUDGES` arrays.
Cost scales with candidates × 3 judges, so `LENSES` is the dial that matters.
