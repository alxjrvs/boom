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
  version "0.36.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "77ec87260d320ef09f2aa767e1a88053e4db0a8a0a7be5bfd198cac1fb6c6654"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "9cfb32f1e9491e3601b35b701f7f87c3259399099a98b140f6f09af70ae3f04a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-arm64"
      sha256 "0c93492f1f0b4a0e8abce1cbdbfaa7958b026e6937d9a93907e9f2fc1b9a9b95"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
      sha256 "17c58ea3f648203502163f7b49b375ae8e5c30462e28b264021b280f3ac0de90"
    end
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
