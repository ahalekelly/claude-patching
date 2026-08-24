#!/usr/bin/env bash
# Pre-launch check, called by the `claude` shell wrapper before starting the
# binary. One rule: launch the best available patched binary now, reconcile the
# newest installed version in the background.
#
# Contract with the wrapper:
#   <target-file> receives the absolute path of the binary to launch; an empty
#                 or missing file means "fall back to `claude` on PATH"
#   exit 0  — nothing printed, launch immediately
#   exit 1  — something was printed (fallback in use / port started / a brief
#             from the port's agents); the wrapper requires an Enter before
#             launching so the message isn't lost when the TUI takes over
#
# The stamp file <binary>.patched holds the identity of the patched binary plus
# a fingerprint of the patch set that produced it, so a binary swapped
# underneath it (an update reinstalling the same version, a restore) or an
# edited patch set fails the check and gets reconciled.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/lib.sh"
STATE="$ROOT/port-state"
TARGET="${1:?usage: check-and-apply.sh <target-file>}"

# The background port launches Claude Code by absolute path with this set; the
# check must not run — let alone spawn another port — inside its own agent.
[[ -n "${CLAUDE_PATCHING_AUTOPORT:-}" ]] && exit 0

BIN="$(realpath "$HOME/.local/bin/claude")"
VER="$(basename "$BIN")"
SELECTED="$(best_patched "$BIN")"

launch() { echo "$1" > "$TARGET"; }

# The port's only human-facing channel: a Fable agent writes one paragraph here
# when it hits something it cannot resolve itself. Read once, then cleared.
BRIEF="$STATE/brief"
brief=""
if [[ -f "$BRIEF" ]]; then
  brief="$(<"$BRIEF")"
  rm -f "$BRIEF"
fi

launch "$SELECTED"

# The newest installed version is patched: silent fast path.
if [[ "$SELECTED" == "$BIN" ]] && is_patched "$BIN"; then
  [[ -z "$brief" ]] && exit 0
  echo "$brief"
  exit 1
fi

if [[ "$SELECTED" != "$BIN" ]]; then
  FALLBACK="$(basename "$SELECTED")"
  echo "claude-patching: $VER is not patched yet — launching patched $FALLBACK from the archive."
  # Silent indefinite fallback is this design's main risk, and old versions do
  # get hard-deprecated: say so loudly once the gap gets real.
  behind=$(( ${VER##*.} - ${FALLBACK##*.} ))
  days=$(( ( $(file_mtime "$BIN") - $(file_mtime "$SELECTED") ) / 86400 ))
  if [[ "${VER%.*}" != "${FALLBACK%.*}" || $behind -gt 3 || $days -gt 7 ]]; then
    echo "claude-patching: WARNING — that is $behind release(s) and $days day(s) behind $VER. Check $STATE/port-$VER.log."
  fi
else
  echo "claude-patching: no patched binary available — launching stock $VER."
fi
[[ -n "$brief" ]] && echo "$brief"

# Reconcile in the background. Never blocks the launch, and self-damps if the
# port of this version already failed recently.
CLAUDE_PATCHING_AUTOPORT=1 nohup "$ROOT/background-port.sh" "$VER" >/dev/null 2>&1 &
echo "claude-patching: reconciling $VER in the background — see $STATE/port-$VER.log."
exit 1
