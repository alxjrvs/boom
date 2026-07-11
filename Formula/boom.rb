# Homebrew formula — installs the prebuilt boom binary (a single self-contained
# executable compiled from TypeScript via Bun). The repo doubles as its own tap:
#   brew tap alxjrvs/boom https://github.com/alxjrvs/boom
#   brew install boom
# sha256 values are filled in by the release workflow when a tag is cut.
class Boom < Formula
  desc "Installable dotfiles + workspace engine — apply/verify/fix from boomfile.toml"
  homepage "https://github.com/alxjrvs/boom"
  version "0.4.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "82195b39fb68739af8df08204cf2e58c83f0426b9fd47e16a60cbfb6ab36d838"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "71d2d2f02f705df9b5dec9a1b363ebf5c6cf13c18d99915209f882cc415c5416"
    end
  end

  on_linux do
    url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
    sha256 "e91dc9a72259e9ff713e1ee3e42ae87b2fc0f8119638067a7926fb8fa2e1c678"
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
