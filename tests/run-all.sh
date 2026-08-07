#!/usr/bin/env bash
# Functional suite for a candidate Claude Code binary: one behavioral test per
# applied patch, asserting the patched behavior rather than the patch's
# application, so a patch that anchors onto a lookalike site fails here.
#
#   run-all.sh <binary> [dropped-patch-id ...]
#
# Dropped ids are reported as skipped instead of run. Exit 0 = every test that
# ran passed. Run it against a stock binary as the negative control: every test
# must fail there, or it is not discriminating.
set -uo pipefail
TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${1:?usage: run-all.sh <binary> [dropped-patch-id ...]}"
shift
DROPPED=" $* "

PROXY_TESTS="trim-context-bloat tool-defer-whitelist worktree-dedup defer-tool-descriptions"
PTY_TESTS="no-collapse-reads toolsearch-visibility"
# Patches whose behavior the harnesses cannot drive yet: a background agent read
# back through TaskOutput, a cron-fired prompt, the reminder timer, and the
# sticky header, whose render depends on the transcript virtualizer's own
# viewport model rather than on what the emulator has scrolled off screen.
# Reported, never silently counted as passing.
UNCOVERED="quiet-notifications cron-visibility task-reminder-conditional sticky-prompt-header"

pass=0 fail=0 skip=0

report() { # <status> <id> <detail>
  case "$1" in
    pass) pass=$((pass + 1)); printf 'pass  %s\n' "$2";;
    skip) skip=$((skip + 1)); printf 'skip  %-26s %s\n' "$2" "$3";;
    *)    fail=$((fail + 1)); printf 'FAIL  %-26s %s\n' "$2" "$3";;
  esac
}

run() { # <runner...> <id>
  local id="${*: -1}" out
  case "$DROPPED" in *" $id "*) report skip "$id" "patch dropped for this build"; return;; esac
  if out="$("$@" "$BIN" "$id" 2>&1)"; then report pass "$id"
  else report fail "$id" "$(printf '%s' "$out" | tail -1)"; fi
}

for id in $PROXY_TESTS; do run "$TESTS/proxy-suite.py" "$id"; done
for id in $PTY_TESTS; do run "$TESTS/pty-suite.py" "$id"; done
for id in $UNCOVERED; do report skip "$id" "no behavioral test yet"; done

id=mcp-per-subagent
case "$DROPPED" in
  *" $id "*) report skip "$id" "mandatory patch — cannot be dropped";;
  *) if out="$("$TESTS/mcp-per-subagent/run.py" "$BIN" 2>&1)"; then report pass "$id"
     else report fail "$id" "$(printf '%s' "$out" | tail -1)"; fi;;
esac

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
exit $((fail > 0))
