#!/usr/bin/env bash
# Repatch the native Claude Code binary with phate45/claude-patching display patches.
#
# Patches applied (see repo/README.md for details):
#   no-collapse-reads      Read/Grep/Glob shown individually, not "Read 3 files"
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
#   mcp-per-subagent         each subagent gets its own process for the stdio
#                            MCP servers its frontmatter declares inline, and
#                            each such server sees CLAUDE_MCP_PER_AGENT=1
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
PATCH_IDS="no-collapse-reads toolsearch-visibility quiet-notifications cron-visibility tool-defer-whitelist worktree-dedup trim-context-bloat"
LOCAL_PATCH_IDS="defer-tool-descriptions sticky-prompt-header task-reminder-conditional mcp-per-subagent"

BIN="$(realpath "$HOME/.local/bin/claude")"
VER="$(basename "$BIN")"

# patches-local/ is a local overlay of repo/patches/, written by the background
# port for versions upstream has not covered: an index.json per version, and —
# when a patch actually had to be re-anchored — a patch file at the same path it
# has upstream, so its `require('../../lib/output')` still resolves (via the lib
# symlink below, which mirrors the clone's own layout).
LOCAL="$ROOT/patches-local"
[[ -d "$LOCAL" ]] && ln -sfn ../repo/lib "$LOCAL/lib"
INDEX="$LOCAL/$VER/index.json"
[[ -f "$INDEX" ]] || INDEX="$REPO/patches/$VER/index.json"

# A display patch whose anchors drifted beyond re-anchoring can be listed in
# patches-local/<ver>/dropped so one cosmetic patch never pins the machine to an
# old version. mcp-per-subagent is behavioral and never droppable.
DROPPED="$(cat "$LOCAL/$VER/dropped" 2>/dev/null | tr '\n' ' ')"
case " $DROPPED " in
  *" mcp-per-subagent "*) echo "ERROR: mcp-per-subagent is mandatory and cannot be dropped" >&2; exit 1;;
esac

resolve_patch() {
  local id="$1" file
  case " $LOCAL_PATCH_IDS " in
    *" $id "*)
      [[ -f "$LOCAL/$VER/$id.mjs" ]] && echo "$LOCAL/$VER/$id.mjs" || echo "$ROOT/$id.mjs"
      return;;
  esac
  file="$(jq -re --arg id "$id" '.patches[] | select(.id==$id) | .file' "$INDEX" 2>/dev/null)" ||
    { echo "ERROR: no patch for $id on $VER — not in $INDEX" >&2; return 1; }
  [[ -f "$LOCAL/$file" ]] && echo "$LOCAL/$file" || echo "$REPO/patches/$file"
}

# The stock backup is the canonical patch source: back it up on first run,
# always rebuild from it. Re-running on an already-patched binary is safe.
if [[ ! -f "$BIN.orig" ]]; then
  cp "$BIN" "$BIN.orig"
  echo "Backed up stock binary to $BIN.orig"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-patching.XXXXXX")"
JS="$WORK/cli-$VER.js"
"$TWEAKCC" unpack "$JS" "$BIN.orig"

for id in $PATCH_IDS $LOCAL_PATCH_IDS; do
  case " $DROPPED " in *" $id "*) echo "--- $id  DROPPED for $VER"; continue;; esac
  patch="$(resolve_patch "$id")"
  echo "--- $id  ($patch)"
  node "$patch" "$JS"
done

node --check "$JS"
"$TWEAKCC" repack "$JS" "$BIN"

# Repack writes a fresh file, leaving the desktop app's hardlink on the old
# binary. Relink so both launch paths share the patched inode.
APP="$HOME/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude"
[[ -e "$APP" ]] && ln -f "$BIN" "$APP"

# Stamp read by check-and-apply.sh (keep the expression identical there): the
# patched binary's identity plus a fingerprint of every input that decides the
# patched bytes, so a swapped binary or an edited patch set invalidates the
# stamp and the next launch repatches.
{ stat -f '%i %z %m' "$BIN"
  find "$ROOT/apply-display-patches.sh" "$ROOT"/*.mjs "$LOCAL" "$INDEX" -type f 2>/dev/null | sort | xargs cat /dev/null | shasum
} > "$BIN.patched"

# The daemon pre-forks warm spare processes that load the binary's JS at fork
# time; sessions claimed from a pre-repatch spare run stale code. Kill the
# unclaimed spares (their cmdline carries --bg-spare) so the daemon reforks
# from the freshly patched binary.
pkill -f -- '--bg-spare' 2>/dev/null || true

echo "Done. Restart Claude Code sessions to pick up the patches."
