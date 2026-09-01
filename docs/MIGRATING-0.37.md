# Migrating to boom 0.37.0

One removal. If your boomfile declares no `secret` entries, there is nothing to do — and after
five releases and two consumers, none did.

## The `secret` resource is removed

`secret = [{ dst, ref | template, mode?, backend? }]` resolved a vault reference (1Password,
`env:`, `pass:`, age, sops) and wrote the plaintext to a file at sync time. The resource, its
five backends and the `boom doctor --secrets` audit are all gone.

### Why

**Writing a secret to a file is writing a secret somebody can read.** boom's own reference
consumer says so in its `CLAUDE.md`, as a standing rule for every agent that touches the
machine:

> Never put a secret on stdout — stdout is the transcript. A secret written to a file is a
> secret read. To *use* one, pass it: `op run --env-file=F -- CMD`.

boom shipped a resource whose entire purpose is the thing that repo forbids, and that repo is
the only one that has ever used boom in anger. It declared zero secrets. So did the examples.

The subsystem was not sloppy — it had a real ownership discipline, a 0600 default, and a careful
story about never journaling the plaintext it rendered. It was simply a well-built answer to a
question nobody was asking, and it was the single largest source of subtlety in the composer:
`secret` was one of two kinds that could *win* a destination without *owning* it, which is why
the dedupe keyspace is partitioned at all.

### What to do instead

**Resolve at point of use, not at sync time.** A secret that never lands on disk cannot be read
off disk:

```sh
op run --env-file=.env.op -- your-command      # references resolved into the child's env only
```

For a tool that genuinely requires a file, render it from a `run` step you own, so the write is
explicit and yours:

```toml
[[section.run]]
on = "sync"
cmd = 'op inject -i templates/gh-token.tmpl -o ~/.config/gh/token && chmod 600 ~/.config/gh/token'
```

That is longer than the old one-liner on purpose. Writing plaintext to disk should look like a
decision, not like a config key.

## The key still parses

A boomfile carrying `secret = […]` **still loads** — the entry is accepted and ignored, exactly
as `schedule` and `[boom].sudo_askpass` are. A hard schema failure on a key that used to be valid
turns an upgrade into an outage for whoever did not read this file first, and here the
replacement is a real edit rather than a rename.

It is not silent. Every run — `sync`, `verify` and `uninstall` alike — warns once:

```
N `secret` declaration(s) are retired and ignored — boom no longer renders a vault value to a
file. Resolve it at point of use instead (`op run --env-file=F -- CMD`), or render it with a
`run` step you own. See MIGRATING-0.37.
```

The warning reports a **count, never the paths**: a `dst` for secret material is exactly what
should not be echoed into a transcript. And it fires on `verify` too, not just on mutating runs —
a `verify` reporting "all clear" while ignoring a declared secret is the more dangerous half.

**Anything boom previously rendered is left exactly where it is.** Secrets were deliberately kept
out of the owned-destinations manifest, so orphan reaping never had a claim on them and this
release does not give it one. Delete those files yourself once you have migrated.

## `boom doctor --secrets` is gone

The flag audited whether every declared reference still resolved. With no declarations to audit,
it had nothing to report. `boom doctor` still checks for the 1Password service-account token in
the keychain — and that check is now **strictly better**, because it no longer gates on declared
secrets. It had regressed once by doing exactly that: a machine resolving every credential at
runtime and declaring none — the setup most likely to depend on the token — silenced the check
completely. Presence is the whole signal now.
