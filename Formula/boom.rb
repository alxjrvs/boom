# Homebrew formula — installs the prebuilt boom binary (a single self-contained
# executable compiled from TypeScript via Bun). The repo doubles as its own tap:
#   brew tap alxjrvs/boom https://github.com/alxjrvs/boom
#   brew install boom
# sha256 values are filled in by the release workflow when a tag is cut.
class Boom < Formula
  desc "Installable dotfiles + workspace engine — apply/verify/fix from boomfile.toml"
  homepage "https://github.com/alxjrvs/boom"
  version "0.5.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "16da61b71b984689d003919eeb0b90caca8459f0123bc262097d945fb2179f00"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "8e36a74da07ea0f2a1e33ae0ef597e313f488152bccf59f853d66ee9e73c299c"
    end
  end

  on_linux do
    url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
    sha256 "1aca98dd5660b7e3758cc44f987dbe86749fda727831a24dc9e8ea88365c3768"
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
