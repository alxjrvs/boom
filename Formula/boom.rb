# Homebrew formula — installs the prebuilt boom binary (a single self-contained
# executable compiled from TypeScript via Bun). The repo doubles as its own tap:
#   brew tap alxjrvs/boom https://github.com/alxjrvs/boom
#   brew install boom
# sha256 values are filled in by the release workflow when a tag is cut.
class Boom < Formula
  desc "Installable dotfiles + workspace engine — apply/verify/fix from boomfile.toml"
  homepage "https://github.com/alxjrvs/boom"
  version "0.6.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "eddd39738b48ef9fa8000e28205ffbfea78cdead1d9389eb45af1326fd4a83cf"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "7274df2dc74197de31b80c37e89bf30579fe492a48a001c03adca282f5083890"
    end
  end

  on_linux do
    url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
    sha256 "e6e300d757056b79b66e99a0eedfcce3ff9e1b2ce6c5ecfa0dc91c5609dbbebb"
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
