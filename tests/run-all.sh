#!/usr/bin/env bash
# Functional suite for a candidate Claude Code binary: one behavioral test per
# applied patch, asserting the patched behavior rather than the patch's
# application, so a patch that anchors onto a lookalike site fails here.
#
#   run-all.sh <binary> [dropped-patch-id ...]
#
# Dropped ids are reported as skipped instead of run. Exit 0 = every test that
# ran passed and every applied patch had one. Run it against a stock binary as
# the negative control: every test must fail there, or it is not discriminating.
set -uo pipefail
TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${1:?usage: run-all.sh <binary> [dropped-patch-id ...]}"
shift
DROPPED=" $* "

PROXY_TESTS="$("$TESTS/proxy-suite.py" --list)"
PTY_TESTS="$("$TESTS/pty-suite.py" --list)"
LIVE_TESTS="mcp-per-subagent task-notification-provenance"

pass=0 fail=0 skip=0

report() { # <status> <id> <detail>
  case "$1" in
    pass) pass=$((pass + 1)); printf 'pass  %s\n' "$2";;
    skip) skip=$((skip + 1)); printf 'skip  %-26s %s\n' "$2" "$3";;
    *)    fail=$((fail + 1)); printf 'FAIL  %-26s %s\n' "$2" "$3";;
  esac
}

# The reason a test gives, not the last line of its output: several tests dump a
# rendered screen or a message stream after the reason, to make a failure
# diagnosable.
reason() { printf '%s\n' "$1" | grep -m1 '^FAIL' || printf '%s\n' "$1" | tail -1; }

run() { # <runner> <id>
  local runner="$1" id="$2" out
  case "$DROPPED" in *" $id "*) report skip "$id" "patch dropped for this build"; return;; esac
  if out="$("$runner" "$BIN" "$id" 2>&1)"; then report pass "$id"
  else report fail "$id" "$(reason "$out")"; fi
}

for id in $PROXY_TESTS; do run "$TESTS/proxy-suite.py" "$id"; done
for id in $PTY_TESTS; do run "$TESTS/pty-suite.py" "$id"; done

id=mcp-per-subagent
case "$DROPPED" in
  *" $id "*) report skip "$id" "mandatory patch — cannot be dropped";;
  *) if out="$("$TESTS/mcp-per-subagent/run.py" "$BIN" 2>&1)"; then report pass "$id"
     else report fail "$id" "$(reason "$out")"; fi;;
esac

id=task-notification-provenance
case "$DROPPED" in
  *" $id "*) report skip "$id" "patch dropped for this build";;
  *) if out="$("$TESTS/task-notification-provenance/run.py" "$BIN" 2>&1)"; then report pass "$id"
     else report fail "$id" "$(reason "$out")"; fi;;
esac

# Coverage. The suite is only a gate if every applied patch reaches it, so the
# applied set decides what must be tested — an untested patch fails here instead
# of silently not being run. tests/waivers is the escape hatch, and each entry
# has to say why a test cannot exist yet.
for id in $("$TESTS/../apply-display-patches.sh" --print-ids); do
  case "$DROPPED" in *" $id "*) continue;; esac
  case " $PROXY_TESTS $PTY_TESTS $LIVE_TESTS " in *[[:space:]]"$id"[[:space:]]*) continue;; esac
  waiver="$(awk -v id="$id" '$1 == id { $1 = ""; sub(/^ +/, ""); print; exit }' "$TESTS/waivers")"
  if [[ -n "$waiver" ]]; then report skip "$id" "no behavioral test — waived: $waiver"
  else report fail "$id" "applied with no behavioral test"; fi
done

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
exit $((fail > 0))
