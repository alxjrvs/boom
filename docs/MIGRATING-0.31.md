# Migrating to boom 0.31.0

0.31 is the release where boom stopped shipping what nobody ran. Ten verbs are gone and one
`[boom]` key is retired. **No `boomfile.toml` edit is required** — every config that loaded under
0.30 still loads — but scripts, agents and launchd timers that invoke a removed verb will break,
and one of them breaks quietly. Read the ⚠️ section even if you read nothing else.

Everything here is pre-1.0 churn, deliberately taken in one release rather than dripped out.

---

## ⚠️ If your boomfile has `[boom] schedule`, unload its timers by hand

`schedule` generated `com.boomtube.*` LaunchAgents and reaped them when you removed an entry.
The generator is gone — **and so is the reaper**. Removing the key, or upgrading to 0.31, does
**not** unload timers a previous version installed. They stay loaded and keep firing.

If they ran a verb that also went (`code fetch`, `code reap`), every fire now fails and reports
into a log nobody reads — the exact failure shape boom's own last-exit check was built for.

Check and clear them:

```sh
launchctl list | grep com.boomtube
launchctl bootout gui/$(id -u)/com.boomtube.<name>
rm ~/Library/LaunchAgents/com.boomtube.<name>.plist
```

To keep running boom on a timer, author a plist and let the `launchd` **resource** own its
lifecycle — that half is untouched:

```toml
[[section.launchd]]
src = "launchd/com.you.boom-verify.plist"
```

The key itself is still accepted, parsed and ignored, so a boomfile carrying it does not fail to
load. That is deliberate: `[boom]` is a strict table, and failing an entire config over a key
that used to work is worse than ignoring it. It will be deleted at 1.0.

---

## Breaking — commands that no longer exist

boom is six verbs: `verify`, `uninstall`, `source`, `upgrade`, `doctor`, `skill`.

| Gone | Reach for |
|---|---|
| `code` (`init`/`claude`/`cmux`/`fetch`/`reap`) | — |
| `status` | `verify` for the machine; `source status` for the config repo |
| `where` | the paths directly: config repo at `~/.local/state/boom/config-repo` |
| `lock` | — (see below) |
| `rollback`, `checkpoint` | — (see below) |
| `plan` | `source --dry-run` |
| `edit` | `$EDITOR ~/.local/state/boom/config-repo` |
| `mcp` | your client's own MCP registration |
| `completions`, `man` | `boom --help` |

`boom source status` is **not** affected — it is a subcommand of `source`, and it is the
config-repo check, distinct from the removed top-level `status`.

Shell completions installed from a previous `boom completions` still exist on disk and will
suggest verbs that no longer route. Regenerate or delete them.

---

## Behavior changes — no edit, but a run does something different

### `boom verify` no longer audits package drift

A repo with a `boom.lock` used to have brew/mise version drift folded into verify's warning tier.
`lock` is gone and so is that audit: **verify reports whether the machine matches the boomfile** —
validity, not whether a resolved package moved underneath you.

An existing `boom.lock` is now inert. Nothing reads it, nothing refreshes it. Delete it.

### There is no undo verb, but originals are still preserved

`boom rollback` is gone. The journal is **not** — it has two consumers in the sync path, and both
are why it stays:

- `displace()` moves an existing file into `backups/<run-id>/` (0700) before an overwrite. This
  is what makes `source --fix` non-destructive.
- `--resume` reads the last uncommitted run to continue it rather than opening a second.

So an overwrite still parks the original where you can find it. What changed is that **nothing
replays it for you** — recovery from a bad sync is a manual copy out of that tree.

### A failing `run` step reports everything it printed

A `[[section.run]]` failure used to render as `(exit N): <last line of stderr>`. For a
purpose-written command that is systematically the *worst* line: a script states its most specific
complaint first and adds context after. All output is now reported, indented, and **stdout is
captured too** — a step that explained itself on stdout previously failed with no reason at all.

Package managers are unchanged: brew/mise/apt/op failures still report a one-line tail, which is
right for output that is long, templated, and worst-line-last.

---

## Nothing to do

Every resource — `link`, `copy`, `tmpl`, `secret`, `dir`, `pkg`, `osx_default`, `launchd`,
`systemd`, `run`, `check`, `hook`, `absent` — is untouched, as are `source`'s subcommands, the
`[boom]` keys `skill_on_sync`, `upgrade_on_sync` and `notify`, and every flag on the six
surviving verbs.
