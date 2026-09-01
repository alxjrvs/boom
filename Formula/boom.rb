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
  version "0.35.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "3e54157124a85801a149140cfe424322b7a6f321ef236ce1888b71628ffe0184"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "eb24555e1b4bed58b0cdda5bbbd83b8398a89226412fb030070f567ed0b9bb59"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-arm64"
      sha256 "1646d29c2ed3d90feeb776b5e1352650774b078375f7e5fa4df4423859ba0d74"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
      sha256 "bbecbb0d88c0dcab8d84d498fae6154f3d027396d6b0a6c07cf33fd5996d04ff"
    end
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
