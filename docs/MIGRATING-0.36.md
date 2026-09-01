# Migrating to boom 0.36.0

One removal, and one setting value that now means something slightly different. If you install
boom with a package manager and your boomfile says `upgrade_on_sync = "check"`, there is nothing
to do.

## `boom upgrade` is removed

The verb that downloaded a newer release and rewrote the running binary in place is gone, along
with `--check`.

### Why

**A self-replacing binary and a package manager cannot both own the same file.** boom ships a
Homebrew formula, and its reference consumer now installs it that way. `boom upgrade` writing a
new binary into a brew-managed prefix desynchronises brew's manifest from what is actually on
disk: `brew list --versions alxjrvs/boom/boom` reports one version, the binary reports another, and the next
`brew upgrade` silently reverts to whatever the formula pins. Nothing errors; you simply stop
being able to trust either answer.

That is not a hypothetical about someone else's setup — it is the shape boom's own consumer had,
and closing it is what prompted this.

### What to do instead

Upgrade boom the way you installed it:

```sh
brew upgrade alxjrvs/boom/boom                      # Homebrew — the name must be qualified;
                                                    # bare `boom` is an unrelated cask
curl -fsSL .../install.sh | sh                      # the curl-pipe bootstrap, re-run
```

`install.sh` still verifies the download against the release's published `SHA256SUMS` and refuses
to install unverified. That has not changed.

## `upgrade_on_sync = "auto"` is retired, and still accepted

`"auto"` called `boom upgrade`, so it goes with it. A boomfile carrying it **still loads** — the
value is not rejected — and now behaves exactly like `"check"`: after a sync, boom prints a
one-line notice when a newer release is available, and says once that `"auto"` was treated as
`"check"`.

Accepted rather than rejected on purpose: a hard schema failure on a value that used to be valid
turns an upgrade into an outage for anyone who did not read this file first. Change it to
`"check"` at your leisure; the notice will stop.

`"check"` itself is unchanged — cheap, non-fatal, offline-safe.
