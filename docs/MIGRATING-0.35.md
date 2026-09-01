# Migrating to boom 0.35.0

One removal. If your `boomfile.toml` has no `[[section.check]]` — and boom's own reference
consumer has none — there is nothing to do.

## `check` is removed

The `check` resource is gone, along with its `json` assertions, `cmd` assertions, `repair`,
`missing_file`, and the `present`/`absent` regex pair it carried. A boomfile declaring one now
fails to load: `SectionSchema` is a `strictObject`, so the error names `check` as an unknown key.

### Why

It had no consumer. boom's reference consumer never declared one, and the boomfile it does
declare contains a written argument for why a verify-time `run` step beat `check` for the job it
was reaching for. 221 lines and the highest branch density in the codebase, for a resource
nothing used.

There was also a footgun worth naming on the way out: a `cmd` check ran arbitrary shell during
`verify`, a verb documented as read-only. The header said "read-only **by contract**" — enforced
by nothing — so a `cmd` that mutated turned a drift report into a writer.

### What to use instead

A verify-time `run` step, which is what the assertions were competing with:

```toml
[[section.run]]
on = "verify"
cmd = "grep -q 'op-agent' ~/.claude/settings.json || { echo 'cached-PAT regression'; exit 1; }"
```

`run` gives you the shell you were going to reach for anyway, reports through the same drift
exit code (0 ok / 2 warn / 1 fail), and honours `timeout`, `unless` and `creates`.

For "this path must not exist", `absent` is unchanged and is the direct replacement for the
inverse case:

```toml
absent = [{ path = "~/.claude/settings.local.json", message = "machine-local override" }]
```

### Still here

`copy`, `tmpl` and `secret` are unchanged in 0.35. They were considered in the same pass and
kept: unlike `check`, each is entangled with the precedence and manifest test coverage as a
second *kind* — the tests that assert last-wins across kinds, and that a kind owning no
destination never evicts one that does, are written against them. Removing them means rewriting
that coverage against `link` + `launchd` first, which is a separate piece of work and not
something to bolt onto a resource deletion.
