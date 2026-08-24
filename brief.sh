#!/usr/bin/env bash
# The port's only channel to a human: one paragraph from a Fable agent that hit
# something it could not resolve itself.
#
#   brief.sh <paragraph>
#
# Appended, never overwritten — the escalation and the advisory pass can both
# have something to say. The next launch prints the whole file and clears it;
# on macOS a Terminal window shows it right away too, so an urgent brief is not
# waiting on the next launch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIEF="$ROOT/port-state/brief"
TEXT="${1:?usage: brief.sh <paragraph>}"

mkdir -p "$ROOT/port-state"
printf 'claude-patching: %s\n' "$TEXT" >> "$BRIEF"

# The AppleScript-level timeout keeps a GUI-less context — launchd, a daemon
# job, ssh — from hanging on the AppleEvent instead of leaving the brief for
# the next launch to print.
if [[ "$(uname)" == Darwin ]]; then
  osascript -e "with timeout of 15 seconds
tell application \"Terminal\" to do script \"cat '$BRIEF'\"
end timeout" >/dev/null 2>&1 || true
fi
