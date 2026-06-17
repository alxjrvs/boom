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
echo "botu: installed → $BIN/botu"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "botu: add $BIN to your PATH (e.g. export PATH=\"$BIN:\$PATH\")" ;;
esac
