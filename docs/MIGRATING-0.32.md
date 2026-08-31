# Migrating to boom 0.32.0

0.32 removes three resource-level surfaces that had no user. Unlike 0.31 — which removed commands
and required no config edit — **these are load-time errors**. Config is parsed before any verb
runs, so `boom verify`, `boom doctor --config` and `boom source` all fail identically until the
file is fixed. That is the point: a config that can't be satisfied should never look half-fine.

If your boomfile uses none of the three below, there is nothing to do.

---

## Breaking — a config edit is required

### 1. `systemd` is gone

The Linux service resource is removed. A `[[section.systemd]]` entry is now an unknown key on a
strict table, so the whole file fails to load.

```toml
# rejected at load
[[section]]
name = "Services"
systemd = [{ name = "backup", exec = "/usr/bin/backup", timer = "daily" }]
```

There is no in-boom replacement. Write the unit yourself and place it with `copy` or `link`, then
enable it with a `run` step — or stay on 0.31.x, which is the honest answer if you manage Linux
services with boom.

### 2. Seven package managers are gone — `brew`, `mise`, `gh` remain

`apt`, `dnf`, `cargo`, `npm`, `pipx`, `gem` and `flatpak` are removed from the `manager`
picklist. A `pkg` entry naming one now fails validation.

```toml
# rejected at load
pkg = [{ manager = "cargo", packages = ["ripgrep"] }]

# still fine
pkg = [{ manager = "brew", packages = ["ripgrep"] }]
```

The replacement is a `run` step, which is what these arms were: a shell-out with a presence
check. `run` gives you the same thing without boom pretending to model it.

```toml
run = [{ cmd = "cargo install ripgrep", unless = "command -v rg" }]
```

### 3. Three secret backends are gone — `op` and `env` remain

`pass`, `age` and `sops` are removed from the `backend` picklist.

```toml
# rejected at load
secret = [{ dst = "~/.tok", ref = "pass:tokens/gh", backend = "pass" }]
```

`op` (1Password) and `env` are what remain, and they are the two that resolve without shelling
out to a CLI that may not be installed. If you use one of the three, 0.31.x is where they live.

---

## Why these went

Each was a working feature with no user, not dead code. boom's only consumer is a single macOS
machine that installs through `brew`, `mise` and `gh`, and resolves secrets through 1Password.
`systemd` *is* the Linux story, and there is no Linux machine.

That makes this a bet rather than a cleanup: if a Linux box or a `pass` user ever appears, this
is a revert and not a rewrite — which is the right shape for a bet at 0.x, and the reason it is
recorded here rather than left to a reader to reconstruct from a diff.

---

## Nothing to do

`link`, `copy`, `tmpl`, `secret` (with `op`/`env`), `dir`, `pkg` (with `brew`/`mise`/`gh`),
`osx_default`, `launchd`, `run`, `check`, `hook` and `absent` are untouched, as are all six verbs
and every `[boom]` key.
