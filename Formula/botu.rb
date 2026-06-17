# Homebrew formula — installs the prebuilt botu binary (a single self-contained
# executable compiled from TypeScript via Bun). The repo doubles as its own tap:
#   brew tap alxjrvs/botu https://github.com/alxjrvs/botu
#   brew install botu
# sha256 values are filled in by the release workflow when a tag is cut.
class Botu < Formula
  desc "Installable dotfiles + workspace engine — apply/verify/fix from botufile.toml"
  homepage "https://github.com/alxjrvs/botu"
  version "0.0.1"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/botu/releases/download/v#{version}/botu-bun-darwin-arm64"
      sha256 "REPLACE_WITH_DARWIN_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/alxjrvs/botu/releases/download/v#{version}/botu-bun-darwin-x64"
      sha256 "REPLACE_WITH_DARWIN_X64_SHA256"
    end
  end

  on_linux do
    url "https://github.com/alxjrvs/botu/releases/download/v#{version}/botu-bun-linux-x64"
    sha256 "REPLACE_WITH_LINUX_X64_SHA256"
  end

  def install
    bin.install Dir["botu-*"].first => "botu"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/botu --version")
  end
end
