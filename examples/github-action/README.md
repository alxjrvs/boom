# boom verify — GitHub Action

CI-gate your boom config repo (your dotfiles) on every pull request. This composite
action installs `boom` and runs [`boom verify --ci`](../../README.md), which parse- and
schema-checks your `boomfile.toml` and every overlay non-interactively — exit `0` when the
config is valid, `1` when it isn't. It's a **config gate**, not a machine check: no
reconcile, no machine walk, safe to run on a stock runner.

## Use it

In your dotfiles repo, add `.github/workflows/boom.yml`:

```yaml
name: boom
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: alxjrvs/boom/examples/github-action@main
```

`actions/checkout` puts your `boomfile.toml` in the working directory; boom resolves the
config from there and validates it. A schema error (an unknown key, a mistyped overlay,
a malformed resource) fails the check and blocks the merge.
