#!/usr/bin/env bats
# The concurrency lock: two mutating reconciles racing would corrupt state, so a
# pidfile under $XDG_STATE_HOME/botu/run.lock guards apply/fix/uninstall. A live
# pid blocks a second run; a dead pid is reclaimed; verify and --dry-run mutate
# nothing and so never take the lock.

load helper

setup() {
  botu_setup
  export BOTU_CONFIG="$CONFIG"
  LOCK="$XDG_STATE_HOME/botu/run.lock"
  mkdir -p "$(dirname "$LOCK")"
  printf 'x\n' > "$CONFIG/f"
  write_botufile <<'EOF'
link f ~/.f
EOF
}
teardown() { botu_teardown; }

@test "a live pid in the lock blocks a mutating run" {
  printf '%s\n' "$$" > "$LOCK" # this test process is alive ⇒ a held lock
  run botu apply
  [ "$status" -eq 1 ]
  [[ "$output" == *"another run in progress"* ]]
  [ ! -e "$HOME/.f" ] # blocked before any mutation
}

@test "a dead pid in the lock is reclaimed" {
  (exit 0) & # spawn and reap a child so its pid is (almost certainly) free
  dead=$!
  wait "$dead" 2> /dev/null || true
  kill -0 "$dead" 2> /dev/null && skip "pid $dead was reused — cannot prove staleness"
  printf '%s\n' "$dead" > "$LOCK"
  run botu apply
  [ "$status" -eq 0 ]
  [ -L "$HOME/.f" ]    # reclaimed and ran
  [ ! -e "$LOCK" ]     # and released its own lock on exit
}

@test "verify does not take the lock" {
  botu apply # link in place so verify is clean
  printf '%s\n' "$$" > "$LOCK" # a live lock that must NOT block a read-only verb
  run botu verify
  [ "$status" -eq 0 ]
  [[ "$output" != *"another run in progress"* ]]
}

@test "--dry-run does not take the lock" {
  printf '%s\n' "$$" > "$LOCK" # a live lock that must NOT block a no-op run
  run botu apply --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"another run in progress"* ]]
}
