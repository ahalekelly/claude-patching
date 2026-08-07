#!/usr/bin/env bash
# Escalation path for background-port.sh: ask a headless Opus session to
# re-anchor the patches that no longer apply to <version>.
#
#   port-agent.sh <version> <apply-log>
#
# It runs in this directory, sandboxed in auto permission mode, and by design
# can only write to patches-local/<version>/ — the promotion gate, not the
# agent, decides whether anything it produces reaches the launch path.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VER="${1:?usage: port-agent.sh <version> <apply-log>}"
LOG="${2:?usage: port-agent.sh <version> <apply-log>}"
# The newest version upstream covers, which is the closest thing to a baseline.
PREV="$(ls "$ROOT/repo/patches" | grep -v "^$VER$" | sort -V | tail -1)"

read -r -d '' PROMPT <<EOF || true
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

exec "$HOME/.local/share/claude/versions/$VER" -p --model opus \
  --permission-mode auto --add-dir "$ROOT" "$PROMPT"
