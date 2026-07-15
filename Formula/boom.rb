# Homebrew formula — installs the prebuilt boom binary (a single self-contained
# executable compiled from TypeScript via Bun). The repo doubles as its own tap:
#   brew tap alxjrvs/boom https://github.com/alxjrvs/boom
#   brew install boom
# sha256 values are filled in by the release workflow when a tag is cut.
class Boom < Formula
  desc "Declarative dev-machine setup — sync/verify dotfiles, packages, and tools from boomfile.toml"
  homepage "https://github.com/alxjrvs/boom"
  version "0.16.5"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "f111ecf1696a71ebee1145b05df37a7005596aaba0e294f78a0fafcd1eea3658"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "cab0e1a8d9269945ddb4089d31fa1fd310a55f3562f3b9e5a440f13339c6b336"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-arm64"
      sha256 "4e499a308af7b2ac313a73a80f7d2d04d406c037b362d0bbdf90e065f5c861c1"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
      sha256 "9ed17c8893b6b483a74a17ce73602698dcb7d8037659e5e9cf6f8a78cc825ea9"
    end
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
