#!/usr/bin/env bats
# Orphan reaping + the manifest: apply records every declared destination to
# $XDG_STATE_HOME/botu/manifest. When a `link` line is later deleted, the symlink
# it made dangles forever unless reaped. verify WARNS about such an orphan;
# fix/apply REAP it — but only links still pointing into the repo (never a
# foreign symlink that happens to share the destination).

load helper

setup() {
  botu_setup
  export BOTU_CONFIG="$CONFIG"
  MANIFEST="$XDG_STATE_HOME/botu/manifest"
}
teardown() { botu_teardown; }

@test "apply records declared destinations in the manifest" {
  printf 'x\n' > "$CONFIG/f"
  write_botufile <<'EOF'
link f ~/.f
EOF
  botu apply
  [ -f "$MANIFEST" ]
  run cat "$MANIFEST"
  [[ "$output" == *"$HOME/.f"* ]]
}

@test "verify warns about an orphan after its link line is removed" {
  printf 'a\n' > "$CONFIG/a"
  printf 'b\n' > "$CONFIG/b"
  write_botufile <<'EOF'
link a ~/.a
link b ~/.b
EOF
  botu apply
  write_botufile <<'EOF'
link a ~/.a
EOF
  run botu verify
  [ "$status" -eq 2 ] # a warning, not a failure
  [[ "$output" == *"no longer declared"* ]]
  [ -L "$HOME/.b" ] # verify only warns — it never removes
}

@test "fix reaps the orphan, keeps the declared link" {
  printf 'a\n' > "$CONFIG/a"
  printf 'b\n' > "$CONFIG/b"
  write_botufile <<'EOF'
link a ~/.a
link b ~/.b
EOF
  botu apply
  write_botufile <<'EOF'
link a ~/.a
EOF
  run botu fix
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/.b" ] # reaped
  [ -L "$HOME/.a" ]   # kept
}

@test "apply reaps the orphan too" {
  printf 'a\n' > "$CONFIG/a"
  printf 'b\n' > "$CONFIG/b"
  write_botufile <<'EOF'
link a ~/.a
link b ~/.b
EOF
  botu apply
  write_botufile <<'EOF'
link a ~/.a
EOF
  run botu apply
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/.b" ]
}

@test "reaping spares a symlink that no longer points into the repo" {
  printf 'x\n' > "$CONFIG/f"
  write_botufile <<'EOF'
link f ~/.f
EOF
  botu apply # ~/.f → $CONFIG/f, recorded in the manifest
  rm -f "$HOME/.f"
  ln -s /etc/hosts "$HOME/.f" # a foreign symlink now squats the destination
  write_botufile <<'EOF'
# f is no longer declared
EOF
  run botu fix
  [ "$status" -eq 0 ]
  [ -L "$HOME/.f" ] # NOT reaped — its target is outside our repo
  [ "$(readlink "$HOME/.f")" = "/etc/hosts" ]
}
