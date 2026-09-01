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
  version "0.37.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "4ba82f92786855595c1d6954fcd4593e94d77f132037e1209876abadb14d672d"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "c0432064238430078b4ac3a5b3253d9f72a7da81dd4d91f53f185c8f6faeab7e"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-arm64"
      sha256 "4ca6e7c46b62167afd229b930eb2334b3f80da14ca7044335758fceecdc3ceb9"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
      sha256 "4904a6b4362d533ea14f29f43b6e29a2a83d58fe6cf3d67b8617e61621241ff2"
    end
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
