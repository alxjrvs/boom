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
  version "0.38.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "8e0e22b83e23fed142efc9438422b156b8d2ca54829927e75af9228baab1db69"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "ba12f59d2888d2a5ff0444d9166f7e9c0f2cd0798a494bedc91d0e080315568d"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-arm64"
      sha256 "b7f6b71c38c46511c8fdd3647de428c292453dc29fc2e464b009fd0ca1ec455b"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
      sha256 "d71a6d78ce548e7b9fb6e32ccabbeec48f41a62f5beadbc34f3a2d302e5e6e1c"
    end
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
