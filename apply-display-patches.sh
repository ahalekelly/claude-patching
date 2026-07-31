#!/usr/bin/env bash
# Repatch the native Claude Code binary with phate45/claude-patching display patches.
#
# Patches applied (see repo/README.md "Display & UX"):
#   no-collapse-reads      Read/Grep/Glob shown individually, not "Read 3 files"
#   read-summary           Read(file.js · lines 200-229) instead of Read(file.js)
#   toolsearch-visibility  ToolSearch calls visible
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
PATCH_IDS="no-collapse-reads read-summary toolsearch-visibility"

BIN="$(realpath "$HOME/.local/bin/claude")"
VER="$(basename "$BIN")"
INDEX="$REPO/patches/$VER/index.json"
if [[ ! -f "$INDEX" ]]; then
  echo "ERROR: no patch set for Claude Code $VER — try: git -C $REPO pull" >&2
  exit 1
fi

WORK="$(mktemp -d)"
JS="$WORK/cli-$VER.js"
"$TWEAKCC" unpack "$JS" "$BIN"

for id in $PATCH_IDS; do
  file="$(jq -re --arg id "$id" '.patches[] | select(.id==$id) | .file' "$INDEX")" ||
    { echo "ERROR: patch $id missing from $INDEX" >&2; exit 1; }
  echo "--- $id"
  node "$REPO/patches/$file" "$JS"
done

if [[ ! -f "$BIN.orig" ]]; then
  cp "$BIN" "$BIN.orig"
  echo "Backed up stock binary to $BIN.orig"
fi
"$TWEAKCC" repack "$JS" "$BIN"

# Repack writes a fresh file, leaving the desktop app's hardlink on the old
# binary. Relink so both launch paths share the patched inode.
APP="$HOME/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude"
[[ -e "$APP" ]] && ln -f "$BIN" "$APP"

# Identity stamp read by check-and-apply.sh — records which binary was patched,
# so anything that replaces it (an update, a restore) invalidates the stamp.
stat -f '%i %z %m' "$BIN" > "$BIN.patched"
echo "Done. Restart Claude Code sessions to pick up the patches."
