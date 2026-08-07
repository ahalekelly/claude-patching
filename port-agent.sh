#!/usr/bin/env bash
# Tier 2 of the port: ask a Claude agent to re-anchor the patches that no longer
# apply to <version>. Only background-port.sh calls this, and only when the
# mechanical pass has failed.
#
#   port-agent.sh <version> <apply-log>
#
# The agent runs in a visible Terminal window so the port is watchable while it
# happens, sandboxed in auto permission mode, and this script blocks until that
# window's run finishes so the caller can retry the mechanical pass against the
# overlay it wrote. Its only intended output is patches-local/<version>/; the
# promotion gate, not the agent, decides whether anything it produces reaches
# the launch path.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$ROOT/port-state"
VER="${1:?usage: port-agent.sh <version> <apply-log>}"
LOG="${2:?usage: port-agent.sh <version> <apply-log>}"
# The newest version upstream covers, which is the closest thing to a baseline.
PREV="$(ls "$ROOT/repo/patches" | grep -v "^$VER$" | sort -V | tail -1)"
mkdir -p "$STATE"
PROMPT="$STATE/port-agent-$VER.prompt"
DONE="$STATE/port-agent-$VER.done"
RUN="$STATE/port-agent-$VER.command"
rm -f "$DONE"

cat > "$PROMPT" <<EOF
Port this repository's Claude Code patch set to version $VER.

\`./apply-display-patches.sh $VER /tmp/candidate\` just failed. Its output:

$(tail -60 "$LOG")

The patch set we apply is the PATCH_IDS list plus the local .mjs patches named
in apply-display-patches.sh — not all of the upstream patches. The newest
version upstream covers is $PREV; use repo/patches/$PREV/index.json as the
starting point, and repo/patches/$VER/baseline-find.txt, baseline-replace.txt
and diff-*.json (when present) as drift inputs.

Write the ported patch set to patches-local/$VER/ and nothing else:

- patches-local/$VER/index.json — the id-to-file index in the same shape as
  upstream's, with .file paths relative to repo/patches. Start from $PREV's.
- A patch that genuinely needs re-anchoring goes at patches-local/<the same
  relative path it has under repo/patches>, so its require('../../lib/output')
  still resolves. Re-anchor only what fails; leave the rest pointing upstream.
- A local .mjs patch that needs re-anchoring goes at patches-local/$VER/<id>.mjs.
- A display patch whose anchor has drifted past repair goes in
  patches-local/$VER/dropped, one id per line. mcp-per-subagent is behavioral,
  is never droppable, and its guards firing means Claude Code changed something
  the patch depends on — report that rather than working around it.

Unpack the bundle with ./node_modules/.bin/tweakcc unpack <out.js>
~/.local/share/claude/versions/$VER.orig and iterate against that copy. Do not
touch anything in versions/, do not modify repo/, and do not edit the canonical
patches in this directory. Stop when \`./apply-display-patches.sh $VER
/tmp/candidate\` succeeds, and report what you re-anchored and what you dropped.
EOF

rm -rf "$STATE/port-agent-$VER.lock"

cat > "$RUN" <<EOF
#!/bin/bash
# First executor wins: the Terminal window and the headless fallback can race
# when osascript's reply times out but Terminal runs the script anyway.
mkdir '$STATE/port-agent-$VER.lock' 2>/dev/null || exit 0
cd "$ROOT"
export CLAUDE_PATCHING_AUTOPORT=1
"\$HOME/.local/share/claude/versions/$VER" -p --model opus --permission-mode auto \\
  "\$(cat '$PROMPT')" 2>&1 | tee '$STATE/port-agent-$VER.log'
echo "\${PIPESTATUS[0]}" > '$DONE'
EOF
chmod +x "$RUN"

# A visible Terminal window when a GUI session exists; headless otherwise. The
# AppleScript-level timeout keeps a GUI-less context (daemon, background job)
# from hanging on the AppleEvent instead of falling back.
if osascript -e "with timeout of 15 seconds
tell application \"Terminal\" to do script \"$RUN\"
end timeout" >/dev/null 2>&1; then
  echo "port agent for $VER running in a Terminal window; log: $STATE/port-agent-$VER.log"
else
  echo "no GUI session for a Terminal window — running the port agent headless; log: $STATE/port-agent-$VER.log"
  "$RUN" >/dev/null 2>&1 &
fi

# Block until that window's run finishes, so the caller can retry the mechanical
# pass against whatever overlay the agent wrote.
for _ in $(seq 1 540); do
  [[ -f "$DONE" ]] && exit "$(<"$DONE")"
  sleep 5
done
echo "port agent for $VER did not finish within 45 minutes" >&2
exit 1
