# Homebrew formula — installs the prebuilt boom binary (a single self-contained
# executable compiled from TypeScript via Bun). The repo doubles as its own tap:
#   brew tap alxjrvs/boom https://github.com/alxjrvs/boom
#   brew install boom
# sha256 values are filled in by the release workflow when a tag is cut.
class Boom < Formula
  desc "Installable dotfiles + workspace engine — apply/verify/fix from boomfile.toml"
  homepage "https://github.com/alxjrvs/boom"
  version "0.10.0"

  on_macos do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-arm64"
      sha256 "685c34583f2ec8faf22c46dea3e7339466b84a0071781d539d69be3bb0fab377"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-darwin-x64"
      sha256 "a753adc55419c053739cbc80c5d626d1fc805ce04284cdac585b8ba570d183bf"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-arm64"
      sha256 "6c1b59979917f1ef035f53ddbecb79d4dbcbd01878ba55c95df895bf2ec552ea"
    end
    on_intel do
      url "https://github.com/alxjrvs/boom/releases/download/v#{version}/boom-bun-linux-x64"
      sha256 "f95ca345b206e977493845da6ae6bbd66c70f3db3a7ae892f484baca111542f3"
    end
  end

  def install
    bin.install Dir["boom-*"].first => "boom"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/boom --version")
  end
end
