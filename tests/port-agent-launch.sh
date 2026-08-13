#!/usr/bin/env bash
# Asserts what port-agent.sh hands to the Terminal, without popping a window:
# a stub osascript on PATH records the AppleScript, and a stub done-marker
# releases the wait. Checks the launch line, the flags, and the prompt.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VER="${1:-2.1.223}"
W="$(mktemp -d "${TMPDIR:-/tmp}/port-agent-launch.XXXXXX")"
trap 'rm -rf "$W"' EXIT
fails=0

cat > "$W/osascript" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$W/applescript"
# Stand in for the Terminal window: run nothing, just release the wait.
echo 0 > "$ROOT/port-state/port-agent-$VER.done"
EOF
chmod +x "$W/osascript"
echo "pretend apply failure" > "$W/apply.log"

# Clear the files this run is meant to produce: a real port leaves its own
# behind, and reading those would turn a script that died early into a pass.
rm -f "$ROOT/port-state/port-agent-$VER."{done,command,prompt}

PATH="$W:$PATH" "$ROOT/port-agent.sh" "$VER" "$W/apply.log" >"$W/out" 2>&1
[[ $? -eq 0 ]] || { echo "FAIL: port-agent.sh exited nonzero"; fails=$((fails + 1)); cat "$W/out"; }

script="$(cat "$W/applescript" 2>/dev/null)"
run="$ROOT/port-state/port-agent-$VER.command"
check() { # <label> <needle> <haystack>
  case "$3" in *"$2"*) echo "ok:   $1";; *) echo "FAIL: $1 (missing: $2)"; fails=$((fails + 1));; esac
}
check "launches Terminal via osascript" 'tell application "Terminal" to do script' "$script"
check "runs the generated command file" "$run" "$script"
check "invokes the version binary by absolute path" "versions/$VER\" -p" "$(cat "$run")"
check "uses the opus model" "--model opus" "$(cat "$run")"
check "uses auto permission mode" "--permission-mode auto" "$(cat "$run")"
case "$(cat "$run")" in
  *--dangerously-skip-permissions*) echo "FAIL: bypasses permissions"; fails=$((fails + 1));;
  *) echo "ok:   never bypasses permissions";;
esac
check "sets the recursion guard" "CLAUDE_PATCHING_AUTOPORT=1" "$(cat "$run")"
check "prompt edits failing patches in place" "editing the failing patches/<id>.mjs in place" "$(cat "$ROOT/port-state/port-agent-$VER.prompt")"
check "prompt names the dropped file" "patches-local/$VER/dropped" "$(cat "$ROOT/port-state/port-agent-$VER.prompt")"
check "prompt forbids dropping mcp-per-subagent" "never droppable" "$(cat "$ROOT/port-state/port-agent-$VER.prompt")"

rm -f "$ROOT/port-state/port-agent-$VER."{done,command,prompt}
if [[ $fails -eq 0 ]]; then echo "PASS: port agent launch"; else echo "FAILED: $fails check(s)"; fi
exit $((fails > 0))
