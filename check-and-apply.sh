#!/usr/bin/env bash
# Pre-launch check, called by the `claude` shell wrapper before starting the
# binary. One rule: launch the best available patched binary now, reconcile the
# newest installed version in the background.
#
# Contract with the wrapper:
#   <target-file> receives the absolute path of the binary to launch; an empty
#                 or missing file means "fall back to `claude` on PATH"
#   exit 0  — nothing printed, launch immediately
#   exit 1  — something was printed (fallback in use / port started / port
#             finished); the wrapper requires an Enter before launching so the
#             message isn't lost when the TUI takes over the screen
#
# The stamp file <binary>.patched holds the identity of the patched binary plus
# a fingerprint of the patch set that produced it, so a binary swapped
# underneath it (an update reinstalling the same version, a restore) or an
# edited patch set fails the check and gets reconciled.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$ROOT/repo"
LOCAL="$ROOT/patches-local"
STATE="$ROOT/port-state"
ARCHIVE="$HOME/.local/share/claude/patched"
TARGET="${1:?usage: check-and-apply.sh <target-file>}"

# The background port launches Claude Code by absolute path with this set; the
# check must not run — let alone spawn another port — inside its own agent.
[[ -n "${CLAUDE_PATCHING_AUTOPORT:-}" ]] && exit 0

BIN="$(realpath "$HOME/.local/bin/claude")"
VER="$(basename "$BIN")"
INDEX="$LOCAL/$VER/index.json"
[[ -f "$INDEX" ]] || INDEX="$REPO/patches/$VER/index.json"
# Keep the stamp expression identical in apply-display-patches.sh
STAMP="$(stat -f '%i %z %m' "$BIN"
  find "$ROOT/apply-display-patches.sh" "$ROOT"/*.mjs "$LOCAL" "$INDEX" -type f 2>/dev/null | sort | xargs cat /dev/null | shasum)"

launch() { echo "$1" > "$TARGET"; }

# A finished port leaves a message for the next launch to print.
NOTE="$STATE/port-message"
note=""
if [[ -f "$NOTE" ]]; then
  note="$(<"$NOTE")"
  rm -f "$NOTE"
fi

# 1. The newest installed version is patched: silent fast path.
if [[ -f "$BIN.patched" && "$(<"$BIN.patched")" == "$STAMP" ]]; then
  launch "$BIN"
  [[ -z "$note" ]] && exit 0
  echo "$note"
  exit 1
fi

# 2. Otherwise fall back to the newest archived patched binary, 3. else stock.
FALLBACK="$(ls "$ARCHIVE" 2>/dev/null | sort -V | tail -1)"
if [[ -n "$FALLBACK" ]]; then
  launch "$ARCHIVE/$FALLBACK"
  echo "claude-patching: $VER is not patched yet — launching patched $FALLBACK from the archive."
  # Silent indefinite fallback is this design's main risk, and old versions do
  # get hard-deprecated: say so loudly once the gap gets real.
  behind=$(( ${VER##*.} - ${FALLBACK##*.} ))
  days=$(( ( $(stat -f %m "$BIN") - $(stat -f %m "$ARCHIVE/$FALLBACK") ) / 86400 ))
  if [[ "${VER%.*}" != "${FALLBACK%.*}" || $behind -gt 3 || $days -gt 7 ]]; then
    echo "claude-patching: WARNING — that is $behind release(s) and $days day(s) behind $VER. Check $STATE/port-$VER.log."
  fi
else
  launch "$BIN"
  echo "claude-patching: no patched binary available — launching stock $VER."
fi
[[ -n "$note" ]] && echo "$note"

# Reconcile in the background. Never blocks the launch; the retry damper keeps a
# failing version from respawning an agent on every launch.
if [[ -f "$STATE/$VER.failed" ]] &&
   [[ -z "$(find "$STATE/$VER.failed" -maxdepth 0 -mmin +1440 2>/dev/null)" ]] &&
   [[ "$(head -1 "$STATE/$VER.failed")" == "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" ]]; then
  echo "claude-patching: the port of $VER failed recently — not retrying. See $STATE/port-$VER.log; delete $STATE/$VER.failed to force a retry."
else
  mkdir -p "$STATE"
  CLAUDE_PATCHING_AUTOPORT=1 nohup "$ROOT/background-port.sh" "$VER" >>"$STATE/port-$VER.log" 2>&1 &
  echo "claude-patching: porting the patch set to $VER in the background — this session keeps running whatever launched above."
fi
exit 1
