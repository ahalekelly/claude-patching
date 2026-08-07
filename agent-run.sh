#!/usr/bin/env bash
# Run one Claude Code agent for the port, and block until it finishes.
#
#   agent-run.sh <version> <tag> <prompt-file> <timeout-minutes>
#
# The agent runs the version being ported, sandboxed in auto permission mode,
# in a visible Terminal window when a GUI session exists and headless otherwise,
# so a port is watchable while it happens without ever depending on a GUI. This
# script blocks until that window's run finishes, and exits with the agent's own
# exit code. Its log is port-state/<tag>-<version>.log.
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
"\$HOME/.local/share/claude/versions/$VER" -p --model opus --permission-mode auto \\
  "\$(cat '$PROMPT')" 2>&1 | tee '$LOG'
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
