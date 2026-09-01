# Migrating to boom 0.38.0

One removal, and it is a flag rather than config. If you have never typed `boom source --update`,
there is nothing to do — your boomfile does not change, and `boom verify` and
`boom doctor --config` behave exactly as before.

## `boom source --update` is gone

The flag opted a sync into upgrading outdated Homebrew packages. It is removed, and
`brew bundle` now runs with `--no-upgrade` on every verb, unconditionally.

| Removed | Native equivalent |
| --- | --- |
| `boom source --update` | `brew upgrade --formula`, and `mise upgrade` |

Run them when you want them, which is the point: neither is boom's to schedule.

### Why

**The flag's blast radius was not what its name said.** Homebrew Bundle's upgrade covers *casks*
as well as formulae — observed on Homebrew 6.0.12, dropping `--no-upgrade` had Bundle run
`brew upgrade --cask` on an outdated cask that set no `greedy: true` and is `auto_updates: true`,
so the per-cask `greedy` key is not the opt-out it reads as. Upgrading a cask replaces the `.app`,
and Homebrew quits the running program to do it.

So `boom source --update` closed your browser, your chat client and your terminal emulator, and
the thing it delivered in exchange was the formulae — which `brew upgrade --formula` delivers
without touching an app. **A reconcile that closes your browser is not a reconcile.** Reconciling
answers "is what I declared installed?", never "is what is installed current?", and the flag was
the one place those two questions were mixed.

It also did less than it looked like it did. `--update` never reached mise: a sync ran
`mise install` with or without it, and `mise upgrade` on neither path. Anyone reading the flag as
"update my machine" got their GUI apps restarted and their CLI toolchain left exactly where it was.

**And boom does not need an opinion here.** `brew upgrade --formula` and `mise upgrade` already
exist, already mean precisely this, and each carries the blast radius its own tool defines. A boom
flag standing in front of them is a third definition of "upgrade", free to drift from both — the
same argument that removed the four git-wrapping subcommands in
[0.33](MIGRATING-0.33.md).

### Nothing silently changes behavior

`--update` is not accepted-and-ignored. The flag no longer exists, so `boom source --update`
fails to parse — `No flag registered for --update`, non-zero, nothing reconciled — rather than
running and quietly doing something other than what you asked. A retired *config key* is worth
accepting for a release (that is why `secret` and `sudo_askpass` still parse); a retired *flag*
typed by hand is better off failing loudly, because the fix is one line in a script or one habit.

## The `HookApi` loses `update`

A hook received the run's context as `{ with, verb, dryRun, env, repo, vars, os, host, profiles,
linkMode, verbose, update }`. `update` is gone from that object. With the flag removed it could
only ever have been `false`, and a field that is always one value is a field that lies to the next
person who reads it.

If a hook of yours branches on `api.update`, delete the branch — the `false` arm is the only one
that was reachable after this release anyway. Everything else in `HookApi` is untouched.

## Not gone: everything about how a cask installs

boom still installs declared casks, still narrates Homebrew's `==>` headers while one is
escalating, and still labels the sudo prompt via `SUDO_PROMPT` so it is never anonymous. Cask
*installation* is its own escalation path — a `launchctl`/`pkgutil` stanza reaches for `sudo` the
first time a cask lands — and none of that machinery depended on the flag.

`brew bundle cleanup` reporting (and removal, where a `pkg` entry opts into it) is unchanged, as
is `brew bundle check` on `verify`: drift is still "declared and not installed", which is what it
has always meant. A merely-outdated package was never drift and still isn't.
