#!/usr/bin/env bash
# Tier 2 of the port: ask a Claude agent to re-anchor the patches that no longer
# apply to <version>. Only background-port.sh calls this, and only when the
# mechanical pass has failed.
#
#   port-agent.sh <version> <apply-log>
#
# The agent re-anchors committed patches in place and verifies them against the
# functional suite; when a fix needs more than a re-anchor (a stale test
# fixture, a droppable patch) it consults a Fable subagent, which owns the
# judgment call and commits contract-side changes separately. The promotion
# gate still decides whether patch edits reach the launch path, and
# background-port.sh commits them only after that gate passes.
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

Re-anchor the failing patches/<id>.mjs in place. Re-anchor only what fails;
leave every patch that still applies alone. Do not git-commit anything under
patches/ — the port commits those itself after its functional gate passes.

Once the apply succeeds, run the suite the same way the port's gate will:

  tests/run-all.sh /tmp/candidate <skip-ids>

where <skip-ids> is the contents of patches-local/$VER/dropped plus every
patches/*.mjs id absent from \`./apply-display-patches.sh --print-ids\`.
Iterate until it passes. A test that fails the same way on the stock binary
($VERSIONS/$VER.orig) is a stale contract, not patch drift — Claude Code's
behavior moved underneath the fixture.

Anything beyond a re-anchor is a judgment call, and judgment calls go to
Fable: spawn a subagent with the Agent tool, model "fable", hand it your
diagnosis and evidence, and do what it decides. That covers stale contracts,
edits to tests/ or the harness, dropping a patch that has a test, and any case
where the right move is unclear. Fable may change the contract; when it does,
commit that change on its own — tests/ and harness edits in their own commit
with the rationale in the message, never mixed with patches/. This port is
meant to finish without human input on most versions: consult Fable rather
than leaving a blocker for a human.

For a patch whose anchor has drifted past repair, write its id to
patches-local/$VER/dropped, one id per line. mcp-per-subagent is behavioral,
is never droppable, and its guards firing means Claude Code changed something
the patch depends on — take that to Fable.

Keep the house style when you re-anchor: content-bearing anchors (property
names, string literals — never a bare control-flow shape), an exact match-count
assertion, splice by index rather than a substring replace, and a loud refusal
on any drift.

Do not touch anything in $VERSIONS. Stop when
\`./apply-display-patches.sh $VER /tmp/candidate\` succeeds and the suite
passes, and report what you re-anchored, what you dropped, and what Fable
decided.
EOF

exec "$ROOT/agent-run.sh" "$VER" port-agent "$PROMPT" 45
