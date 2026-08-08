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
# the next launch take the silent fast path. After promotion an advisory agent
# reviews what the port learned; it recommends, it never edits.
set -uo pipefail
# launchd and systemd fire the autoport with a minimal PATH that misses the
# tools this needs: claude lives in ~/.local/bin, and on macOS node, jq and uv
# in /opt/homebrew/bin. Without them the mechanical apply fails on a missing
# node and the port reports it as patch drift.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/lib.sh"
LOCAL="$ROOT/patches-local"
STATE="$ROOT/port-state"
VERSIONS="$HOME/.local/share/claude/versions"
ARCHIVE="$HOME/.local/share/claude/patched"
APP="$HOME/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude"
export CLAUDE_PATCHING_AUTOPORT=1

VER="${1:-$(basename "$(realpath "$HOME/.local/bin/claude")")}"
BIN="$VERSIONS/$VER"
mkdir -p "$LOCAL" "$STATE"

# The port owns its log, so a run started by hand leaves the same trace as one
# spawned by a launch, launchd, or systemd — every caller sends our output to
# /dev/null.
exec > >(tee -a "$STATE/port-$VER.log") 2>&1

say() { echo "[$(date '+%F %T')] $*"; }

# Retry damper. Both the launch check and the versions watcher fire this script,
# and the watcher can fire repeatedly, so a version whose port failed must not
# respawn an agent every time. A day, or any change to the patch set, clears it.
# No desktop notification here for the same reason.
if [[ -f "$STATE/$VER.failed" ]] &&
   [[ -z "$(find "$STATE/$VER.failed" -maxdepth 0 -mmin +1440 2>/dev/null)" ]] &&
   [[ "$(head -1 "$STATE/$VER.failed")" == "$(fingerprint)" ]]; then
  say "the port of $VER failed recently — not retrying; delete $STATE/$VER.failed to force a retry"
  printf 'claude-patching: the port of %s failed recently — not retrying. See %s; delete %s to force a retry.\n' \
    "$VER" "$STATE/port-$VER.log" "$STATE/$VER.failed" > "$STATE/port-message"
  exit 0
fi

# One port per version at a time; self-heal a lock left by a crashed run.
LOCK="$STATE/port-$VER.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]] && rmdir "$LOCK" 2>/dev/null
  mkdir "$LOCK" 2>/dev/null || { echo "port of $VER already running"; exit 0; }
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-port.XXXXXX")"
trap 'rmdir "$LOCK" 2>/dev/null; rm -rf "$WORK"' EXIT

finish() { # <headline> — notify now, and leave a note for the next launch
  say "$1"
  printf 'claude-patching: %s\n' "$1" > "$STATE/port-message"
  notify "claude-patching" "$1"
}

fail() { # <reason>
  { fingerprint
    date '+%F %T'
    echo "$1"; } > "$STATE/$VER.failed"
  finish "port of $VER failed: $1"
  exit 1
}

say "porting $VER"

# Drop state for versions Claude Code no longer has installed. Before the
# candidate is built rather than after: patches-local/ counts toward the patch
# set's fingerprint, so pruning it later would leave the stamp we just wrote
# describing inputs that no longer exist.
pruned=""
for dir in "$LOCAL"/*/; do
  v="$(basename "$dir")"
  [[ -d "$dir" && ! -f "$VERSIONS/$v" ]] && { rm -rf "$dir"; pruned="$pruned patches-local/$v"; }
done
for entry in "$STATE"/*; do
  v="$(basename "$entry" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [[ -e "$entry" && -n "$v" && ! -f "$VERSIONS/$v" ]] &&
    { rm -rf "$entry"; pruned="$pruned $(basename "$entry")"; }
done
# Our own leftovers in the versions directory, 270 MB apiece, once the version
# they belong to is gone. Nothing else in there is ours to delete.
for sibling in "$VERSIONS"/*.orig "$VERSIONS"/*.patched; do
  v="$(basename "$sibling")"
  [[ -e "$sibling" && ! -f "$VERSIONS/${v%.*}" ]] && { rm -rf "$sibling"; pruned="$pruned $v"; }
done
[[ -n "$pruned" ]] && say "pruned state for uninstalled versions:$pruned"

# A watcher event can fire while the updater is still writing the binary. That
# is not a failed port — no agent escalation, no 24-hour damper — so exit
# quietly and let the next versions-directory event retry. The .orig backup
# guard in apply-display-patches.sh stays as the last line of defense.
"$BIN" --version >/dev/null 2>&1 ||
  { say "$VER does not execute yet — still being installed; not porting"; exit 0; }

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
# Patches not in this machine's effective set (default-off ones never enabled,
# or locally disabled) get their suite tests skipped the same way dropped
# per-version patches do.
EFFECTIVE="$("$ROOT/apply-display-patches.sh" --print-ids)"
for id in $(basename -s .mjs "$ROOT/patches/"*.mjs); do
  case " $EFFECTIVE " in *" $id "*) ;; *) DROPPED="$DROPPED $id";; esac
done
"$CAND" --version >/dev/null 2>&1 || fail "the candidate does not report a version"
"$CAND" -p --model sonnet "reply with the single word ok" >/dev/null 2>&1 ||
  fail "the candidate cannot complete a prompt"
"$ROOT/tests/run-all.sh" "$CAND" $DROPPED || fail "the functional suite did not pass"

# The same suite against the stock binary. Every test is meant to fail here — a
# test that passes has lost its discrimination, which means one of: Anthropic
# shipped the behavior natively, the assertion drifted vacuous and its pass on
# the candidate proves nothing, or a flake. The per-test reasons are kept
# because they carry the mirror case too: a test asserting a patch artifact (the
# MCP canary, a defer stub's text) can never pass on stock even once Anthropic
# fixes the underlying behavior, and only its failure reason says which. The
# advisory agent classifies; the port just records.
STOCK_LOG="$STATE/stock-suite-$VER.log"
"$ROOT/tests/run-all.sh" "$VERSIONS/$VER.orig" $DROPPED > "$STOCK_LOG" 2>&1
SUSPECT="$(awk '$1=="pass"{printf "%s ", $2}' "$STOCK_LOG")"
[[ -n "$SUSPECT" ]] && say "suspect — these tests also pass on stock $VER: $SUSPECT"

# Promotion. Under the same lock check-and-apply.sh takes, so no launch ever
# reads a half-promoted state, and every file is written new then moved into
# place — macOS caches a Mach-O's code signature per inode, while Linux rejects
# overwriting a running ELF with ETXTBSY.
if ! mkdir "$BIN.lock" 2>/dev/null; then
  [[ -n "$(find "$BIN.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]] && rmdir "$BIN.lock" 2>/dev/null
  mkdir "$BIN.lock" 2>/dev/null || fail "a launch holds the binary lock"
fi
mkdir -p "$ARCHIVE"
cp "$CAND" "$BIN.new" && mv "$BIN.new" "$BIN"
cp "$CAND" "$ARCHIVE/$VER.new" && mv "$ARCHIVE/$VER.new" "$ARCHIVE/$VER"
ls "$ARCHIVE" | sort -Vr | tail -n +3 | while read -r old; do rm -f "$ARCHIVE/$old"; done

{ file_id "$BIN"; fingerprint; } > "$BIN.patched"

# Relink the app bundle so desktop and daemon launches share what the terminal
# launches, then drop everything still running pre-promotion JS. The daemon's
# warm spares load the binary's JS at fork time; a session claimed from a spare
# rewrites its argv to its own resume command, so the only thing that still
# names it is the --bg-pty-host wrapper it hangs off — kill each wrapper's
# direct children and the sessions go with it. The match spans every daemon on
# the machine deliberately: live daemon-attached sessions die here too —
# accepted, because the daemon auto-resumes each one in seconds on the freshly
# promoted binary.
[[ -e "$APP" ]] && ln -f "$BIN" "$APP"
for wrapper in $(pgrep -f -- '--bg-pty-host' 2>/dev/null); do
  pkill -P "$wrapper" 2>/dev/null || true
  kill "$wrapper" 2>/dev/null || true
done
pkill -f -- '--bg-spare' 2>/dev/null || true
rmdir "$BIN.lock" 2>/dev/null
rm -f "$STATE/$VER.failed"

finish "$VER promoted${DROPPED:+ (dropped:$DROPPED)}${SUSPECT:+ (suspect:$SUSPECT)} — restart sessions to pick it up"

# Re-anchor debt. A re-anchor in patches-local/ wins for one version only, so a
# committed patch that stopped fitting costs the port agent another repair every
# release while patches/ stays stale. Count the releases each one has been
# carried for, so that toil shows up in the note instead of being paid silently.
for id in $EFFECTIVE; do
  case " $DROPPED " in *" $id "*) continue;; esac
  [[ -f "$LOCAL/$VER/$id.mjs" ]] || continue
  grep -qxF "$VER $id" "$STATE/reanchor-history" 2>/dev/null || echo "$VER $id" >> "$STATE/reanchor-history"
  releases="$(grep -c " $id\$" "$STATE/reanchor-history")"
  first="$(grep " $id\$" "$STATE/reanchor-history" | head -1 | cut -d' ' -f1)"
  debt="re-anchor debt: $id has run on a local re-anchor for $releases release(s) (since $first) — patches/$id.mjs is stale"
  say "$debt"
  printf 'claude-patching: %s\n' "$debt" >> "$STATE/port-message"
done

# Advisory pass. Promotion is already done, so a slow or failed review costs
# nothing; its recommendations join the note the next launch prints.
ADVICE="$STATE/advisory-$VER.md"
rm -f "$ADVICE"
if "$ROOT/advisory-agent.sh" "$VER" "$STOCK_LOG" "$ADVICE" && [[ -s "$ADVICE" ]]; then
  headline="$(head -1 "$ADVICE")"
  printf 'claude-patching: upstream watch for %s: %s\n  full review: %s\n' "$VER" "$headline" "$ADVICE" \
    >> "$STATE/port-message"
  notify "claude-patching: upstream watch" "$headline"
  say "advisory: $headline"
else
  say "the advisory agent produced nothing — see $STATE/advisory-$VER.log"
fi
