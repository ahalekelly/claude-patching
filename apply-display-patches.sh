#!/usr/bin/env bash
# Repatch the native Claude Code binary with phate45/claude-patching display patches.
#
# Patches applied (see repo/README.md for details):
#   no-collapse-reads      Read/Grep/Glob shown individually, not "Read 3 files"
#   read-summary           Read(file.js · lines 200-229) instead of Read(file.js)
#   toolsearch-visibility  ToolSearch calls visible
#   quiet-notifications    task notifications don't re-carry output the session
#                          already read via TaskOutput
#   cron-visibility        cron/loop-fired prompts visible with a CronJob prefix,
#                          which also reaches the model
#   tool-defer-whitelist   tools in CLAUDE_CODE_IMMEDIATE_TOOLS (settings.json
#                          env) skip ToolSearch deferral
#   worktree-dedup         duplicate CLAUDE.md/.claude/rules content injected
#                          once, nearest copy wins
#   trim-context-bloat     drops userEmail, currentDate, and the model-family
#                          paragraph from the system prompt (a UserPromptSubmit
#                          hook in settings.json supplies live date/time instead)
# Plus local patches (not from the repo):
#   defer-tool-descriptions  Workflow/Artifact tool descriptions become short
#                            stubs pointing at the workflow-tool/artifact-tool
#                            skills, which hold the full text
#   sticky-prompt-header     previous-prompt header above the transcript shows
#                            whenever the prompt is off-screen (stock: only
#                            when scrolled up), styled like a transcript user
#                            message (stock: grey on grey)
#   task-reminder-conditional  the periodic task_reminder nag only fires when
#                            the session's task list is non-empty
# Deliberately NOT applied: thinking-visibility / thinking-no-fold — they pin
# thinking blocks permanently inline; stock behavior (streams while thinking,
# collapses to a pill after) is what we want, via showThinkingSummaries.
#
# Run after every Claude Code update (updates replace the binary and drop the patches).
# If the new version has no patch set yet: git -C repo pull, or wait for upstream.
#
# Restore stock binary — copy to a new file and rename, never write the live
# binary in place. macOS caches a Mach-O's code signature per inode, so an
# in-place overwrite leaves the kernel SIGKILLing every launch of that inode:
#   cd <versions-dir> && cp <ver>.orig <ver>.new && mv <ver>.new <ver>
#   ln -f <ver> ~/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$ROOT/repo"
TWEAKCC="$ROOT/node_modules/.bin/tweakcc"
PATCH_IDS="no-collapse-reads read-summary toolsearch-visibility quiet-notifications cron-visibility tool-defer-whitelist worktree-dedup trim-context-bloat"

BIN="$(realpath "$HOME/.local/bin/claude")"
VER="$(basename "$BIN")"
INDEX="$REPO/patches/$VER/index.json"
if [[ ! -f "$INDEX" ]]; then
  echo "ERROR: no patch set for Claude Code $VER — try: git -C $REPO pull" >&2
  exit 1
fi

# The stock backup is the canonical patch source: back it up on first run,
# always rebuild from it. Re-running on an already-patched binary is safe.
if [[ ! -f "$BIN.orig" ]]; then
  cp "$BIN" "$BIN.orig"
  echo "Backed up stock binary to $BIN.orig"
fi

WORK="$(mktemp -d)"
JS="$WORK/cli-$VER.js"
"$TWEAKCC" unpack "$JS" "$BIN.orig"

for id in $PATCH_IDS; do
  file="$(jq -re --arg id "$id" '.patches[] | select(.id==$id) | .file' "$INDEX")" ||
    { echo "ERROR: patch $id missing from $INDEX" >&2; exit 1; }
  echo "--- $id"
  node "$REPO/patches/$file" "$JS"
done

echo "--- defer-tool-descriptions (local)"
node "$ROOT/defer-tool-descriptions.mjs" "$JS"

echo "--- sticky-prompt-header (local)"
node "$ROOT/sticky-prompt-header.mjs" "$JS"

echo "--- task-reminder-conditional (local)"
node "$ROOT/task-reminder-conditional.mjs" "$JS"

"$TWEAKCC" repack "$JS" "$BIN"

# Repack writes a fresh file, leaving the desktop app's hardlink on the old
# binary. Relink so both launch paths share the patched inode.
APP="$HOME/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude"
[[ -e "$APP" ]] && ln -f "$BIN" "$APP"

# Stamp read by check-and-apply.sh (keep the expression in sync there): the
# patched binary's identity plus a patch-set fingerprint, so a swapped binary
# or an edited patch set invalidates the stamp and the next launch repatches.
{ stat -f '%i %z %m' "$BIN"
  cat "$ROOT/apply-display-patches.sh" "$ROOT/defer-tool-descriptions.mjs" "$ROOT/sticky-prompt-header.mjs" "$ROOT/task-reminder-conditional.mjs" "$INDEX" 2>/dev/null | shasum
} > "$BIN.patched"

# The daemon pre-forks warm spare processes that load the binary's JS at fork
# time; sessions claimed from a pre-repatch spare run stale code. Kill the
# unclaimed spares (their cmdline carries --bg-spare) so the daemon reforks
# from the freshly patched binary.
pkill -f -- '--bg-spare' 2>/dev/null || true

echo "Done. Restart Claude Code sessions to pick up the patches."
