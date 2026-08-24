#!/usr/bin/env bash
# Asserts what port-agent.sh hands the headless agent, without spending a model
# call: it is pointed at a version that is not installed, so the run dies on the
# missing binary within a second and releases the wait. Checks the launch line,
# the flags, and the prompt.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VER="${1:-0.0.0-not-installed}"
W="$(mktemp -d "${TMPDIR:-/tmp}/port-agent-launch.XXXXXX")"
trap 'rm -rf "$W"' EXIT
fails=0

echo "pretend apply failure" > "$W/apply.log"

# Clear the files this run is meant to produce: a real port leaves its own
# behind, and reading those would turn a script that died early into a pass.
rm -f "$ROOT/port-state/port-agent-$VER."{done,command,prompt,log}

# An empty HOME hides the machine's archived builds, so the run cannot fall back
# to a real binary.
HOME="$W" "$ROOT/port-agent.sh" "$VER" "$W/apply.log" >"$W/out" 2>&1

run="$ROOT/port-state/port-agent-$VER.command"
prompt="$ROOT/port-state/port-agent-$VER.prompt"
[[ -f "$run" && -f "$prompt" ]] || { echo "FAIL: port-agent.sh left no command or prompt file"; cat "$W/out"; exit 1; }

check() { # <label> <needle> <haystack>
  case "$3" in *"$2"*) echo "ok:   $1";; *) echo "FAIL: $1 (missing: $2)"; fails=$((fails + 1));; esac
}
check "reports a headless run" "running headless" "$(cat "$W/out")"
check "invokes a binary by absolute path" "versions/$VER' -p" "$(cat "$run")"
check "uses the opus model" "--model opus" "$(cat "$run")"
check "uses auto permission mode" "--permission-mode auto" "$(cat "$run")"
case "$(cat "$run")" in
  *--dangerously-skip-permissions*) echo "FAIL: bypasses permissions"; fails=$((fails + 1));;
  *) echo "ok:   never bypasses permissions";;
esac
check "sets the recursion guard" "CLAUDE_PATCHING_AUTOPORT=1" "$(cat "$run")"
check "prompt re-anchors failing patches in place" "Re-anchor the failing patches/<id>.mjs in place" "$(cat "$prompt")"
check "prompt names the dropped file" "patches-local/$VER/dropped" "$(cat "$prompt")"
check "prompt forbids dropping mcp-per-subagent" "never droppable" "$(cat "$prompt")"
check "prompt sends judgment calls to Fable" 'model "fable"' "$(cat "$prompt")"

rm -f "$ROOT/port-state/port-agent-$VER."{done,command,prompt,log}
if [[ $fails -eq 0 ]]; then echo "PASS: port agent launch"; else echo "FAILED: $fails check(s)"; fi
exit $((fails > 0))
