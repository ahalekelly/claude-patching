#!/usr/bin/env bash
# Reconcile a Claude Code version with our patch set, off the launch path.
#
#   background-port.sh [version]      (default: the newest installed version)
#
# Spawned detached by check-and-apply.sh, so nothing here may block a launch.
# It builds a candidate — mechanically first, escalating to the port agent only
# when a patch no longer applies — puts it through the functional suite, and
# promotes it only if that passes. A promoted binary lands in versions/, is
# archived outside the pruned versions/ directory, and gets the stamp that makes
# the next launch take the silent fast path.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$ROOT/repo"
LOCAL="$ROOT/patches-local"
STATE="$ROOT/port-state"
VERSIONS="$HOME/.local/share/claude/versions"
ARCHIVE="$HOME/.local/share/claude/patched"
APP="$HOME/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude"
export CLAUDE_PATCHING_AUTOPORT=1

VER="${1:-$(basename "$(realpath "$HOME/.local/bin/claude")")}"
BIN="$VERSIONS/$VER"
mkdir -p "$LOCAL" "$STATE"

# One port per version at a time; self-heal a lock left by a crashed run.
LOCK="$STATE/port-$VER.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]] && rmdir "$LOCK" 2>/dev/null
  mkdir "$LOCK" 2>/dev/null || { echo "port of $VER already running"; exit 0; }
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-port.XXXXXX")"
trap 'rmdir "$LOCK" 2>/dev/null; rm -rf "$WORK"' EXIT

say() { echo "[$(date '+%F %T')] $*"; }

finish() { # <headline> — notify now, and leave a note for the next launch
  say "$1"
  printf 'claude-patching: %s\n' "$1" > "$STATE/port-message"
  osascript -e "display notification \"$1\" with title \"claude-patching\"" 2>/dev/null || true
}

fail() { # <reason>
  { git -C "$REPO" rev-parse HEAD 2>/dev/null || echo none
    date '+%F %T'
    echo "$1"; } > "$STATE/$VER.failed"
  finish "port of $VER failed: $1"
  exit 1
}

say "porting $VER"
git -C "$REPO" pull --quiet 2>/dev/null || true

CAND="$WORK/claude-$VER"
if ! "$ROOT/apply-display-patches.sh" "$VER" "$CAND" > "$WORK/apply.log" 2>&1; then
  tail -20 "$WORK/apply.log"
  say "patches do not apply cleanly — escalating to the port agent"
  "$ROOT/port-agent.sh" "$VER" "$WORK/apply.log" || say "the port agent exited nonzero"
  "$ROOT/apply-display-patches.sh" "$VER" "$CAND" > "$WORK/apply.log" 2>&1 ||
    { tail -20 "$WORK/apply.log"; fail "the patch set still does not apply after re-anchoring"; }
fi
cat "$WORK/apply.log"
chmod +x "$CAND"

DROPPED="$(cat "$LOCAL/$VER/dropped" 2>/dev/null | tr '\n' ' ')"
"$CAND" --version >/dev/null 2>&1 || fail "the candidate does not report a version"
"$CAND" -p --model sonnet "reply with the single word ok" >/dev/null 2>&1 ||
  fail "the candidate cannot complete a prompt"
"$ROOT/tests/run-all.sh" "$CAND" $DROPPED || fail "the functional suite did not pass"

# Promotion. Under the same lock check-and-apply.sh takes, so no launch ever
# reads a half-promoted state, and every file is written new then moved into
# place — macOS caches a Mach-O's code signature per inode, so overwriting a
# live binary leaves the kernel SIGKILLing every launch of it.
if ! mkdir "$BIN.lock" 2>/dev/null; then
  [[ -n "$(find "$BIN.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]] && rmdir "$BIN.lock" 2>/dev/null
  mkdir "$BIN.lock" 2>/dev/null || fail "a launch holds the binary lock"
fi
mkdir -p "$ARCHIVE"
cp "$CAND" "$BIN.new" && mv "$BIN.new" "$BIN"
cp "$CAND" "$ARCHIVE/$VER.new" && mv "$ARCHIVE/$VER.new" "$ARCHIVE/$VER"
ls "$ARCHIVE" | sort -Vr | tail -n +3 | while read -r old; do rm -f "$ARCHIVE/$old"; done

INDEX="$LOCAL/$VER/index.json"
[[ -f "$INDEX" ]] || INDEX="$REPO/patches/$VER/index.json"
# Keep the stamp expression identical in check-and-apply.sh
{ stat -f '%i %z %m' "$BIN"
  find "$ROOT/apply-display-patches.sh" "$ROOT"/*.mjs "$LOCAL" "$INDEX" -type f 2>/dev/null | sort | xargs cat /dev/null | shasum
} > "$BIN.patched"

# Relink the app bundle so desktop and daemon launches share what the terminal
# launches, and drop the daemon's warm spares, which load the binary's JS at
# fork time and would otherwise keep serving pre-promotion code. This match is
# deliberately broad: sessions claimed from a spare keep --bg-spare in their
# argv, so live daemon-attached sessions die here too — accepted, because the
# daemon auto-resumes each one in seconds on the freshly promoted binary.
[[ -e "$APP" ]] && ln -f "$BIN" "$APP"
pkill -f -- '--bg-spare' 2>/dev/null || true
rmdir "$BIN.lock" 2>/dev/null
rm -f "$STATE/$VER.failed"

finish "$VER promoted${DROPPED:+ (dropped:$DROPPED)} — restart sessions to pick it up"
