# Migrating to boom 0.33.0

0.33 removes the four `boom source` subcommands that wrapped git: `status`, `diff`, `push` and
`reset`. Nothing in your **boomfile** changes — these were commands, not config, so `boom verify`
and `boom doctor --config` behave exactly as before. Only a script or muscle-memory that typed one
of the four is affected.

`boom source`, `boom source sync` (including `--commit`/`-m`), `boom source set`, `boom verify`,
`boom uninstall`, `boom upgrade`, `boom doctor` and `boom skill` are untouched.

---

## Breaking — four subcommands are gone

Each wrapped git against the managed config-repo clone. Run git there directly instead. The clone's
path is printed by `boom doctor`; below it is `<dir>`.

| Removed | Native equivalent |
| --- | --- |
| `boom source status` | `git -C <dir> status -sb` |
| `boom source diff` | `git -C <dir> diff HEAD` |
| `boom source reset` | `git -C <dir> reset --hard origin/<branch>` |
| `boom source push` | `git -C <dir> commit -am "…" && git -C <dir> push`, then `gh pr create` |

Notes on the two that did more than pass arguments through:

- **`reset`** also ran `git clean -fd` and refused to discard commits no remote had without
  `--force`. Both are yours to decide now: check with `git -C <dir> log --oneline @{u}..` before
  resetting, and add `git -C <dir> clean -fd` if you want the untracked files gone too.
- **`push`** committed, published `HEAD` as `boom/<slug>-<sha>` *without checking the branch out*
  (the clone's working tree is what every symlink points at), then opened a PR. If you want that
  behavior, it is `git -C <dir> push origin HEAD:refs/heads/<branch>` followed by
  `gh pr create --head <branch>`.

---

## Not gone: drift reporting

boom still tells you when the config repo has drifted — `boom verify` reports commits behind
origin, unpushed local commits, and an uncommitted tree, and `boom doctor` reports the clone and
whether its remote is reachable. What is gone is boom *acting* on that clone. `boom source set`
still refuses to re-clone over uncommitted or unpushed work.

---

## Why these went

boom has one consumer, and it never invoked any of the four; three had no test coverage in the
consumer's usage at all. They were a second, weaker spelling of commands the user already has, at
the cost of ~730 lines of engine and test code and a `gh` dependency in the engine. Deleting a
wrapper for a built-in is the highest-value change boom can make.

If PR-mode push turns out to be missed, it is a revert rather than a rewrite: it lived in two
self-contained modules and its history is intact.

## Also removed: the pre-sqlite manifest import

`readManifest` used to fall back to reading a legacy TSV at
`~/.local/state/boom/manifest` when the sqlite manifest came back empty, importing it
once. That path is gone.

It only ever mattered for a machine upgrading from a pre-v0.4.0 boom (then named `botu`)
that had not synced since. If that is you, the symptom is silent rather than loud: boom
forgets which destinations it owns, so **orphan reaping stops** — files a removed
`boomfile.toml` entry used to place are left behind instead of being reaped. One
`boom source` rebuilds the manifest from the current boomfile and restores reaping.
