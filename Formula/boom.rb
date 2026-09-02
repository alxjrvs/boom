# Homebrew formula — installs the prebuilt boom binary (a single self-contained
# executable compiled from TypeScript via Bun). The repo doubles as its own tap:
#   brew tap alxjrvs/boom https://github.com/alxjrvs/boom
#   brew install alxjrvs/boom/boom
# The name must be FULLY QUALIFIED: bare `boom` resolves to an unrelated
# homebrew-cask entry, and brew reports it "already installed" while this
# formula is absent.
# sha256 values are filled in by the release workflow when a tag is cut.
class Boom < Formula
  desc "Declarative dev-machine setup — sync/verify dotfiles, packages, and tools from boomfile.toml"
  homepage "https://github.com/alxjrvs/boom"
  version "0.38.3"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "6f4c995d199ce5bce5d14ca9da4348469825da420b1ef2a008ce3677af27cf37"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "944641263c2edb94b5b044fb3e49b8e082d4b337e351117bc06dc1afbce5afd7"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-arm64"
      sha256 "1bcdadfd655ca5ec91f57af121eaac208b33e3a74045a470a6d2dd402b352ecd"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
      sha256 "9fd0f00a9ed9a09c027bc7874fb2ce64b6abee8da0fc4e3ffc1cc4bfe43690b1"
    end
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
