#!/usr/bin/env bash
# Upstream watch: after a promotion, ask a Claude agent what the port implies
# for the patch set. Recommendations only — it never edits a patch, and the
# promoted binary is already live by the time it runs.
#
#   advisory-agent.sh <version> <stock-suite-log> <output-file>
#
# Two questions. What has phate45/claude-patching — the project that pioneered
# this approach, and still the best source of new patch ideas — done since we
# last looked. And what does the stock run of our own suite say about patches
# Claude Code may have made redundant.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$ROOT/port-state"
VER="${1:?usage: advisory-agent.sh <version> <stock-suite-log> <output-file>}"
STOCK_LOG="${2:?usage: advisory-agent.sh <version> <stock-suite-log> <output-file>}"
OUT="${3:?usage: advisory-agent.sh <version> <stock-suite-log> <output-file>}"
mkdir -p "$STATE"
PROMPT="$STATE/advisory-$VER.prompt"
REVIEWED="$STATE/phate45-reviewed"

cat > "$PROMPT" <<EOF
You are the upstream watch for this Claude Code patching repository. Claude Code
$VER has just been patched and promoted. Report what that implies for the patch
set. Recommend only — do not edit any patch, test or script.

Write your report to $OUT. Its first line is a one-sentence headline (it is read
aloud in a desktop notification and printed at the next launch); the rest is
detail, ordered by how much it matters.

## 1. What upstream has done

phate45/claude-patching pioneered this approach and is still worth watching.
Shallow-fetch it into a temp directory and review the commits after
$(cat "$REVIEWED" 2>/dev/null || echo "<no SHA recorded — review the last 20 commits>"):

    git clone --filter=blob:none https://github.com/phate45/claude-patching "\$(mktemp -d)/upstream"

Look for: patches worth adopting here (we would rewrite them from our own
anchors, never copy their code — that repository has no license), anchoring
techniques better than ours, and retirements or advisories on patches we still
carry. Their retirement of quiet-notifications is the model case: an upstream
note that a patch had become harmful was worth acting on immediately.

When you are done, write upstream's current tip SHA to $REVIEWED, so the next
run reviews only what is new.

## 2. What the stock run says

The same suite that gated this promotion was run against the stock $VER binary,
where every test is meant to fail:

$(cat "$STOCK_LOG")

A test that PASSES on stock has lost its discrimination. That is a flag, not a
verdict, and it has three possible causes worth telling apart:

- Anthropic shipped the behavior natively. The patch is redundant; recommend
  retiring it.
- The assertion drifted vacuous — some unrelated change now satisfies it. The
  test needs strengthening, and until it is strengthened its pass on the
  patched candidate proves nothing, so treat that patch as ungated.
- A flake. Say so, and say what makes you think so.

The mirror case needs the failure reasons, not just the counts. A test that
asserts a patch artifact — the CLAUDE_MCP_PER_AGENT canary, a defer stub's
text — can never pass on stock even if Anthropic has fixed the underlying
problem. Read each stock failure reason and say which ones mean "the behavior
is still broken without us" and which mean "the artifact is simply absent, and
the behavior may well be fixed". Check the $VER release notes for anything that
would confirm the latter.
EOF

exec "$ROOT/agent-run.sh" "$VER" advisory "$PROMPT" 30
