#!/usr/bin/env sh
# install.sh — download the boom binary for this platform and put it on PATH.
# boom is a single self-contained executable (compiled from TypeScript via Bun);
# there is no runtime dependency on the user's machine.
#   curl -fsSL https://raw.githubusercontent.com/alxjrvs/boom/main/install.sh | sh
set -eu

REPO="alxjrvs/boom"
PREFIX="${BOOM_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin"

os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64) target="bun-darwin-arm64" ;;
  Darwin/x86_64) target="bun-darwin-x64" ;;
  Linux/x86_64) target="bun-linux-x64" ;;
  Linux/aarch64 | Linux/arm64) target="bun-linux-arm64" ;;
  *)
    echo "boom: unsupported platform $os/$arch" >&2
    exit 1
    ;;
esac

ver="${BOOM_VERSION:-latest}"
if [ "$ver" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${ver}"
fi
asset="boom-${target}"

mkdir -p "$BIN"
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.sums"' EXIT
echo "boom: downloading ${target} (${ver})…"
curl -fsSL -o "$tmp" "$base/$asset"

# Verify the download against the release's published SHA256SUMS before trusting the
# binary — the curl-pipe bootstrap is otherwise the one install path with no integrity
# check (`boom upgrade` already verifies this same manifest). A checksum tool is present
# on stock macOS (shasum) and virtually every Linux (sha256sum); if neither exists we warn
# and proceed rather than block the install, and BOOM_SKIP_VERIFY=1 opts out explicitly.
verify_sha256() {
  want="$1" file="$2"
  if command -v sha256sum > /dev/null 2>&1; then
    got="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum > /dev/null 2>&1; then
    got="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "boom: warning — no sha256 tool found; skipping checksum verification" >&2
    return 0
  fi
  [ "$got" = "$want" ]
}

if [ "${BOOM_SKIP_VERIFY:-}" = "1" ]; then
  echo "boom: BOOM_SKIP_VERIFY=1 — skipping checksum verification" >&2
elif curl -fsSL -o "$tmp.sums" "$base/SHA256SUMS" 2> /dev/null; then
  want="$(awk -v a="$asset" '$2 == a || $2 == "*"a {print $1}' "$tmp.sums")"
  if [ -z "$want" ]; then
    echo "boom: SHA256SUMS has no entry for $asset — refusing to install" >&2
    exit 1
  fi
  if ! verify_sha256 "$want" "$tmp"; then
    echo "boom: checksum mismatch for $asset — refusing to install" >&2
    exit 1
  fi
  echo "boom: checksum verified"
else
  echo "boom: warning — could not fetch SHA256SUMS; installing without verification" >&2
fi

mv "$tmp" "$BIN/boom"
chmod +x "$BIN/boom"

# macOS release binaries are signed on a real macOS host (Developer ID when configured,
# else ad-hoc), so a downloaded binary should already carry a valid signature. Only
# re-sign ad-hoc as a fallback when verification fails — re-signing a Developer-ID
# binary would replace its signature with an ad-hoc one and undo notarization. No-op on
# Linux. (Verification failure here usually means an old, Linux-cross-compiled asset.)
if [ "$os" = "Darwin" ]; then
  if codesign --verify --strict "$BIN/boom" > /dev/null 2>&1; then
    : # already validly signed — leave it alone
  elif command -v codesign > /dev/null 2>&1; then
    codesign --force --sign - "$BIN/boom" > /dev/null 2>&1 ||
      echo "boom: warning — re-sign failed; if boom is killed, run: codesign --force --sign - $BIN/boom" >&2
  else
    echo "boom: note — if boom is killed on first run, install Xcode CLT (xcode-select --install) and re-run" >&2
  fi
fi

echo "boom: installed → $BIN/boom"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "boom: add $BIN to your PATH (e.g. export PATH=\"$BIN:\$PATH\")" ;;
esac
