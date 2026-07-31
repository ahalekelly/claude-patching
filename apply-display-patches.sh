#!/usr/bin/env bash
# Repatch the native Claude Code binary with phate45/claude-patching display patches.
#
# Patches applied (see repo/README.md "Display & UX"):
#   thinking-visibility    thinking blocks inline in the normal chat view
#   thinking-no-fold       thinking not folded into tool-group pills
#   no-collapse-reads      Read/Grep/Glob shown individually, not "Read 3 files"
#   read-summary           Read(file.js · lines 200-229) instead of Read(file.js)
#   toolsearch-visibility  ToolSearch calls visible
#
# Run after every Claude Code update (updates replace the binary and drop the patches).
# If the new version has no patch set yet: git -C repo pull, or wait for upstream.
# Restore stock binary: cp <binary>.orig <binary>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$ROOT/repo"
TWEAKCC="$ROOT/node_modules/.bin/tweakcc"
PATCH_IDS="no-collapse-reads read-summary toolsearch-visibility thinking-visibility thinking-no-fold"

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
touch "$BIN.patched"   # stamp checked by check-and-apply.sh (SessionStart hook)
echo "Done. Restart Claude Code sessions to pick up the patches."
