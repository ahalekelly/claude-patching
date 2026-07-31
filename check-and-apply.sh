#!/usr/bin/env bash
# Pre-launch check, called by the `claude` shell wrapper before starting the
# binary: keeps the display patches applied across Claude Code updates.
#
# Contract with the wrapper:
#   exit 0  — binary already patched, nothing printed, launch immediately
#   exit 1  — something was printed (patched now / no patch set yet / failed /
#             lock held); the wrapper requires an Enter before launching so the
#             message isn't lost when the TUI takes over the screen
#
# The stamp file <binary>.patched holds the identity of the patched binary
# plus a fingerprint of the patch set that produced it, so a binary swapped
# underneath it (an update reinstalling the same version, a restore) or an
# edited patch set fails the check and gets repatched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BIN="$(realpath "$HOME/.local/bin/claude")"
VER="$(basename "$BIN")"
# Keep the stamp expression in sync with apply-display-patches.sh
STAMP="$(stat -f '%i %z %m' "$BIN"
  cat "$ROOT/apply-display-patches.sh" "$ROOT/defer-tool-descriptions.mjs" "$ROOT/sticky-prompt-header.mjs" "$ROOT/repo/patches/$VER/index.json" 2>/dev/null | shasum)"
[[ -f "$BIN.patched" && "$(<"$BIN.patched")" == "$STAMP" ]] && exit 0

# Lock out concurrent launches; self-heal a stale lock from a crashed run
if ! mkdir "$BIN.lock" 2>/dev/null; then
  if [[ -n "$(find "$BIN.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]]; then
    rmdir "$BIN.lock" 2>/dev/null
  fi
  if ! mkdir "$BIN.lock" 2>/dev/null; then
    echo "claude-patching: another launch is patching Claude Code $VER — launching the stock binary; try again in a minute."
    exit 1
  fi
fi
trap 'rmdir "$BIN.lock"' EXIT

echo "Claude Code $VER is unpatched — applying display patches..."

# New versions need the upstream patch set; cheap-fail if it isn't there yet
if [[ ! -d "$ROOT/repo/patches/$VER" ]]; then
  git -C "$ROOT/repo" pull --quiet 2>/dev/null || true
  if [[ ! -d "$ROOT/repo/patches/$VER" ]]; then
    echo "claude-patching: no patch set for $VER upstream yet — launching the stock binary."
    echo "Check https://github.com/phate45/claude-patching for updates."
    exit 1
  fi
fi

if "$ROOT/apply-display-patches.sh"; then
  echo "claude-patching: display patches applied — this launch uses the patched binary."
else
  echo "claude-patching: FAILED to patch Claude Code $VER (see output above) — launching the stock binary."
fi
exit 1
