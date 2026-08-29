#!/usr/bin/env bash
# Run one Claude Code agent for the port, and block until it finishes.
#
#   agent-run.sh <version> <tag> <model> <prompt-file> <timeout-minutes>
#
# The agent runs the best patched binary on the machine — never the version
# being ported, which may be the very thing that failed — headless, sandboxed
# in auto permission mode. The run streams: a line lands in the log as each step
# happens, so a half-hour agent reads as progress rather than as a hang. That
# log, port-state/<tag>-<version>.log, is the only trace the run leaves. This
# script blocks until the run finishes, and exits with the agent's own exit code.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/lib.sh"
if ! is_porter; then
  echo "agent-run.sh runs only on porter $(<"$ROOT/porter")" >&2
  exit 1
fi
STATE="$ROOT/port-state"
USAGE="usage: agent-run.sh <version> <tag> <model> <prompt-file> <timeout-minutes>"
VER="${1:?$USAGE}"
TAG="${2:?$USAGE}"
MODEL="${3:?$USAGE}"
PROMPT="${4:?$USAGE}"
MINUTES="${5:?$USAGE}"

CLAUDE="$(best_patched "$HOME/.local/share/claude/versions/$VER")"
mkdir -p "$STATE"
DONE="$STATE/$TAG-$VER.done"
RUN="$STATE/$TAG-$VER.command"
LOG="$STATE/$TAG-$VER.log"
rm -f "$DONE"

cat > "$RUN" <<EOF
#!/bin/bash
cd "$ROOT"
export CLAUDE_PATCHING_AUTOPORT=1
# Use the default profile: the invoker's environment varies (claudew sessions
# export CLAUDE_CONFIG_DIR=.claude-work), and on macOS the variable being set
# at all selects a different Keychain entry that nothing keeps fresh.
unset CLAUDE_CONFIG_DIR
# -p writes nothing until the final message, so the log sits empty for the whole
# run. stream-json emits an event per step instead; render one line each —
# assistant text as written, a tool call as its name and the head of its input,
# the final result in full. Anything that is not an event, stderr included,
# passes through as it came.
'$CLAUDE' -p --model $MODEL --permission-mode auto \\
  --output-format stream-json --verbose "\$(cat '$PROMPT')" 2>&1 |
jq --unbuffered -rR '
  if ((fromjson? | type) // "raw") != "object" then .
  else fromjson
  | if .type == "assistant" then
      .message.content[]
      | if .type == "text" then .text
        elif .type == "tool_use" then "→ " + .name + " " + (.input | tojson)[0:160]
        else empty end
    elif .type == "result" then .result // tojson
    else empty end
  end' | tee '$LOG'
echo "\${PIPESTATUS[0]}" > '$DONE'
EOF
chmod +x "$RUN"

"$RUN" >/dev/null 2>&1 &
echo "$TAG for $VER running headless; log: $LOG"

for _ in $(seq 1 $((MINUTES * 12))); do
  [[ -f "$DONE" ]] && exit "$(<"$DONE")"
  sleep 5
done
echo "$TAG for $VER did not finish within $MINUTES minutes" >&2
exit 1
