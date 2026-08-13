#!/usr/bin/env bash
# Run one Claude Code agent for the port, and block until it finishes.
#
#   agent-run.sh <version> <tag> <prompt-file> <timeout-minutes>
#
# The agent runs the version being ported, sandboxed in auto permission mode,
# in a visible Terminal window when a GUI session exists and headless otherwise,
# so a port is watchable while it happens without ever depending on a GUI. The
# run streams: a line lands in the log as each step happens, so a half-hour
# agent reads as progress rather than as a hang. This script blocks until that
# window's run finishes, and exits with the agent's own exit code. Its log is
# port-state/<tag>-<version>.log.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$ROOT/port-state"
VER="${1:?usage: agent-run.sh <version> <tag> <prompt-file> <timeout-minutes>}"
TAG="${2:?usage: agent-run.sh <version> <tag> <prompt-file> <timeout-minutes>}"
PROMPT="${3:?usage: agent-run.sh <version> <tag> <prompt-file> <timeout-minutes>}"
MINUTES="${4:?usage: agent-run.sh <version> <tag> <prompt-file> <timeout-minutes>}"

mkdir -p "$STATE"
DONE="$STATE/$TAG-$VER.done"
RUN="$STATE/$TAG-$VER.command"
LOG="$STATE/$TAG-$VER.log"
rm -f "$DONE"
rm -rf "$STATE/$TAG-$VER.lock"

cat > "$RUN" <<EOF
#!/bin/bash
# First executor wins: the Terminal window and the headless fallback can race
# when osascript's reply times out but Terminal runs the script anyway.
mkdir '$STATE/$TAG-$VER.lock' 2>/dev/null || exit 0
cd "$ROOT"
export CLAUDE_PATCHING_AUTOPORT=1
# Pin the default profile explicitly: the invoker's environment varies (daemon
# jobs export CLAUDE_CONFIG_DIR=.claude-work, a Terminal window inherits
# nothing), and the agent must authenticate the same way from both paths.
export CLAUDE_CONFIG_DIR="\$HOME/.claude"
# -p writes nothing until the final message, so the log sits empty for the whole
# run. stream-json emits an event per step instead; render one line each —
# assistant text as written, a tool call as its name and the head of its input,
# the final result in full. Anything that is not an event, stderr included,
# passes through as it came.
"\$HOME/.local/share/claude/versions/$VER" -p --model opus --permission-mode auto \\
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

# The AppleScript-level timeout keeps a GUI-less context (daemon, background
# job) from hanging on the AppleEvent instead of falling back to headless.
if osascript -e "with timeout of 15 seconds
tell application \"Terminal\" to do script \"$RUN\"
end timeout" >/dev/null 2>&1; then
  echo "$TAG for $VER running in a Terminal window; log: $LOG"
else
  echo "no GUI session for a Terminal window — running $TAG headless; log: $LOG"
  "$RUN" >/dev/null 2>&1 &
fi

for _ in $(seq 1 $((MINUTES * 12))); do
  [[ -f "$DONE" ]] && exit "$(<"$DONE")"
  sleep 5
done
echo "$TAG for $VER did not finish within $MINUTES minutes" >&2
exit 1
