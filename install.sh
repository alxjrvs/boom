#!/usr/bin/env sh
# install.sh — download the botu binary for this platform and put it on PATH.
# botu is a single self-contained executable (compiled from TypeScript via Bun);
# there is no runtime dependency on the user's machine.
#   curl -fsSL https://raw.githubusercontent.com/alxjrvs/botu/main/install.sh | sh
set -eu

REPO="alxjrvs/botu"
PREFIX="${BOTU_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin"

os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64) target="bun-darwin-arm64" ;;
  Darwin/x86_64) target="bun-darwin-x64" ;;
  Linux/x86_64) target="bun-linux-x64" ;;
  *)
    echo "botu: unsupported platform $os/$arch" >&2
    exit 1
    ;;
esac

ver="${BOTU_VERSION:-latest}"
if [ "$ver" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/botu-${target}"
else
  url="https://github.com/${REPO}/releases/download/${ver}/botu-${target}"
fi

mkdir -p "$BIN"
echo "botu: downloading ${target} (${ver})…"
curl -fsSL -o "$BIN/botu" "$url"
chmod +x "$BIN/botu"

# macOS release binaries are signed on a real macOS host (Developer ID when configured,
# else ad-hoc), so a downloaded binary should already carry a valid signature. Only
# re-sign ad-hoc as a fallback when verification fails — re-signing a Developer-ID
# binary would replace its signature with an ad-hoc one and undo notarization. No-op on
# Linux. (Verification failure here usually means an old, Linux-cross-compiled asset.)
if [ "$os" = "Darwin" ]; then
  if codesign --verify --strict "$BIN/botu" > /dev/null 2>&1; then
    : # already validly signed — leave it alone
  elif command -v codesign > /dev/null 2>&1; then
    codesign --force --sign - "$BIN/botu" > /dev/null 2>&1 ||
      echo "botu: warning — re-sign failed; if botu is killed, run: codesign --force --sign - $BIN/botu" >&2
  else
    echo "botu: note — if botu is killed on first run, install Xcode CLT (xcode-select --install) and re-run" >&2
  fi
fi

echo "botu: installed → $BIN/botu"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "botu: add $BIN to your PATH (e.g. export PATH=\"$BIN:\$PATH\")" ;;
esac
