#!/usr/bin/env bash
# Tier 2 of the port: ask a Claude agent to re-anchor the patches that no longer
# apply to <version>. Only background-port.sh calls this, and only when the
# mechanical pass has failed.
#
#   port-agent.sh <version> <apply-log>
#
# The agent's only intended output is patches-local/<version>/; the promotion
# gate, not the agent, decides whether anything it produces reaches the launch
# path.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$ROOT/port-state"
VERSIONS="$HOME/.local/share/claude/versions"
VER="${1:?usage: port-agent.sh <version> <apply-log>}"
LOG="${2:?usage: port-agent.sh <version> <apply-log>}"
mkdir -p "$STATE"
PROMPT="$STATE/port-agent-$VER.prompt"

# The newest stock bundle still on disk from before this version: diffing it
# against the new one is the most direct evidence of what moved. Often there is
# none — versions/ is pruned — so the pipeline's empty exit must not end the run.
PREV="$(ls "$VERSIONS" 2>/dev/null | grep '\.orig$' | sed 's/\.orig$//' | grep -v "^$VER$" | sort -V | tail -1 || true)"
if [[ -n "$PREV" ]]; then
  PREV_NOTE="The previous stock bundle is still on disk at $VERSIONS/$PREV.orig — unpack it
the same way and diff the two around each failing anchor."
else
  PREV_NOTE="No earlier stock bundle is on disk, so the system-prompt repository below is
the only before/after evidence available."
fi

cat > "$PROMPT" <<EOF
Port this repository's Claude Code patch set to version $VER.

\`./apply-display-patches.sh $VER /tmp/candidate\` just failed. Its output:

$(tail -60 "$LOG")

Every patch is a self-contained script in patches/, listed in application order
at the top of apply-display-patches.sh. Each one's header comment states the
behavior it produces and the anchor it relies on; tests/ holds a behavioral test
per patch, and that test — not the anchor — is the contract.

Unpack the bundle with \`./node_modules/.bin/tweakcc unpack <out.js>
$VERSIONS/$VER.orig\` and iterate against that copy.

Drift inputs:
- $PREV_NOTE
- https://github.com/Piebald-AI/claude-code-system-prompts publishes Claude
  Code's system prompts per release, updated within minutes of each one. It is
  the fastest way to see prompt-text changes, which is what the trim-context-bloat
  and defer-*-description patches anchor on.

Write the ported patch set to patches-local/$VER/ and nothing else:

- patches-local/$VER/<id>.mjs — a re-anchored copy of patches/<id>.mjs, which
  wins over the committed one for this version only. Re-anchor only what fails;
  leave every patch that still applies alone.
- patches-local/$VER/dropped — one id per line, for a patch whose anchor has
  drifted past repair. mcp-per-subagent is behavioral, is never droppable, and
  its guards firing means Claude Code changed something the patch depends on —
  report that rather than working around it.

Keep the house style when you re-anchor: content-bearing anchors (property
names, string literals — never a bare control-flow shape), an exact match-count
assertion, splice by index rather than a substring replace, and a loud refusal
on any drift.

Do not touch anything in $VERSIONS, and do not edit the committed patches in
patches/. Stop when \`./apply-display-patches.sh $VER /tmp/candidate\` succeeds,
and report what you re-anchored and what you dropped.
EOF

exec "$ROOT/agent-run.sh" "$VER" port-agent "$PROMPT" 45
