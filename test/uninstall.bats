#!/usr/bin/env bats
# The `uninstall` verb: removes only botu-owned links/copies (a link whose target
# is our repo, a copy whose contents match), never a foreign file squatting the
# destination. Then it clears the manifest.

load helper

setup() {
  botu_setup
  export BOTU_CONFIG="$CONFIG"
}
teardown() { botu_teardown; }

@test "uninstall removes a botu-owned link and copy" {
  printf 'x\n' > "$CONFIG/f"
  printf 'tool\n' > "$CONFIG/bin-tool"
  write_botufile <<'EOF'
link f ~/.f
copy bin-tool ~/.local/bin/tool
EOF
  botu apply
  [ -L "$HOME/.f" ]
  [ -f "$HOME/.local/bin/tool" ]
  run botu uninstall
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/.f" ]
  [ ! -e "$HOME/.local/bin/tool" ]
}

@test "uninstall leaves a destination it does not own" {
  printf 'x\n' > "$CONFIG/f"
  write_botufile <<'EOF'
link f ~/.f
EOF
  printf 'mine\n' > "$HOME/.f" # a real foreign file, never botu's link
  run botu uninstall
  [ "$status" -eq 0 ]
  [ -f "$HOME/.f" ]
  [ "$(cat "$HOME/.f")" = "mine" ]
}

@test "uninstall leaves a stale copy whose contents differ" {
  printf 'v1\n' > "$CONFIG/f"
  write_botufile <<'EOF'
copy f ~/.f
EOF
  printf 'different\n' > "$HOME/.f" # not a byte-for-byte copy → not ours
  run botu uninstall
  [ "$status" -eq 0 ]
  [ -f "$HOME/.f" ]
  [ "$(cat "$HOME/.f")" = "different" ]
}

@test "uninstall clears the manifest" {
  printf 'x\n' > "$CONFIG/f"
  write_botufile <<'EOF'
link f ~/.f
EOF
  botu apply
  [ -f "$XDG_STATE_HOME/botu/manifest" ]
  run botu uninstall
  [ "$status" -eq 0 ]
  [ ! -e "$XDG_STATE_HOME/botu/manifest" ]
}
