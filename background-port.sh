#!/usr/bin/env bash
# Reconcile a Claude Code version with our patch set, off the launch path.
#
#   background-port.sh [version]      (default: the newest installed version)
#
# Spawned detached by check-and-apply.sh, so nothing here may block a launch.
# It builds a candidate mechanically. The porter re-anchors drift and runs the
# full gate; consumers wait for its pushed patch and run only the cheap checks.
# A promoted binary lands in versions/, is archived outside the pruned versions/
# directory, and gets the stamp that makes the next launch take the silent fast
# path. After promotion on the porter, an advisory agent reviews what the port
# learned and acts on it through Fable.
set -uo pipefail
# launchd and systemd fire the autoport with a minimal PATH that misses the
# tools this needs: claude lives in ~/.local/bin, and on macOS node, jq and uv
# in /opt/homebrew/bin. Without them the mechanical apply fails on a missing
# node and the port reports it as patch drift.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
# On macOS claude keys its Keychain credential entry on whether CLAUDE_CONFIG_DIR
# is set — even set to its default path — and only the unset entry is kept
# fresh, by the interactive `claude` launcher. Every claude the port runs (the
# smoke test, the live-model suite tests) must use that same entry, as the port
# agents in agent-run.sh do, or it fails with an OAuth error no session sees.
unset CLAUDE_CONFIG_DIR
# Nothing here has a human at a terminal to type a git password.
export GIT_TERMINAL_PROMPT=0
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
AGENT_EDITED=0
mkdir -p "$LOCAL" "$STATE"

# The port owns its log, so a run started by hand leaves the same trace as one
# spawned by a launch, launchd, or systemd — every caller sends our output to
# /dev/null.
exec > >(tee -a "$STATE/port-$VER.log") 2>&1

say() { echo "[$(date '+%F %T')] $*"; }

# Everything that can change this port's outcome: the patched bytes' inputs plus
# the gate that judges them. Deliberately broader than the stamp's fingerprint —
# fixing a test, a waiver or the README must clear the damper, but must not
# invalidate an already-promoted stamp.
damper_fingerprint() {
  { fingerprint
    find "$ROOT/tests" -type f -not -path '*__pycache__*' 2>/dev/null | sort | xargs cat /dev/null
    cat "$ROOT/README.md" "$ROOT/ported"; } | "$HASH"
}

# One port per version at a time; self-heal a lock left by a crashed run.
LOCK="$STATE/port-$VER.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]] && rmdir "$LOCK" 2>/dev/null
  mkdir "$LOCK" 2>/dev/null || { echo "port of $VER already running"; exit 0; }
fi
# Scratch on real disk: the candidate is a quarter-gigabyte binary, and /tmp
# can be a small memory-backed tmpfs with per-user quotas. The port lock
# makes the name exclusive, and recreating it heals a killed run's leftovers.
WORK="$STATE/work-$VER"
rm -rf "$WORK" && mkdir "$WORK"
trap 'rmdir "$LOCK" 2>/dev/null; rm -rf "$WORK"' EXIT

# Several machines share this repository, so take whatever the others have
# already committed before deciding anything: the mechanical apply then benefits
# from another machine's re-anchor, and the port agent runs only when nobody has
# fixed this version yet. Ahead of the damper too, so a pulled fix clears it.
# A network problem or a rebase conflict is not a reason to fail a port.
if [[ -n "$(git -C "$ROOT" status --porcelain -- patches/)" ]]; then
  say "patches/ has uncommitted changes — not syncing with origin"
elif ! git -C "$ROOT" pull --rebase --quiet origin master; then
  git -C "$ROOT" rebase --abort 2>/dev/null
  say "could not sync with origin — porting against the local tree"
fi

# Retry damper. Both the launch check and the versions watcher fire this script,
# and the watcher can fire repeatedly. Failed ports wait a day; consumers that
# found drift retry after 30 minutes. A changed fingerprint clears either damper,
# and the pull above happens first so the porter's pushed re-anchor clears a
# consumer's wait immediately.
retry_marker="$STATE/$VER.failed"
retry_minutes=1440
retry_message="the port of $VER failed recently — not retrying; delete $retry_marker to force a retry"
if ! is_porter && [[ -f "$STATE/$VER.waiting" ]]; then
  retry_marker="$STATE/$VER.waiting"
  retry_minutes=30
  retry_message="waiting for $(<"$ROOT/porter") to port $VER — not retrying yet"
fi
if [[ -f "$retry_marker" ]] &&
   [[ -z "$(find "$retry_marker" -maxdepth 0 -mmin +$retry_minutes 2>/dev/null)" ]] &&
   [[ "$(head -1 "$retry_marker")" == "$(damper_fingerprint)" ]]; then
  say "$retry_message"
  exit 0
fi

fail() { # <reason>
  local reason="$1" rejected
  if is_porter && [[ "$AGENT_EDITED" == 1 && -n "$(git -C "$ROOT" status --porcelain -- patches/)" ]]; then
    rejected="$STATE/patches-$VER.rejected.diff"
    git -C "$ROOT" diff -- patches/ > "$rejected"
    git -C "$ROOT" checkout -- patches/
    reason="$reason; rejected patch edits saved to $rejected"
  fi
  { damper_fingerprint
    date '+%F %T'
    echo "$reason"; } > "$STATE/$VER.failed"
  # Escalate detached: this run holds the lock and must exit, and the escalation
  # re-runs the port itself once it has a fix. Once per version — a second
  # failure after Fable's fix must not recurse into another escalation.
  if is_porter && [[ ! -e "$STATE/$VER.escalated" ]]; then
    touch "$STATE/$VER.escalated"
    nohup "$ROOT/escalation-agent.sh" "$VER" "$reason" >/dev/null 2>&1 &
  fi
  say "port of $VER failed: $reason"
  exit 1
}

say "porting $VER"

# Drop state for versions Claude Code no longer has installed. Before the
# candidate is built rather than after: patches-local/ counts toward the patch
# set's fingerprint, so pruning it later would leave the stamp we just wrote
# describing inputs that no longer exist. The updater can uninstall a version
# another port is still working on, so a fresh lock protects everything of its
# version — reclaiming a live run's lock, log or drop list out from under it
# would be worse than a few days of stale files.
protected=" $VER "
for lock in "$STATE"/*.lock; do
  [[ -d "$lock" && -z "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]] || continue
  v="$(basename "$lock" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [[ -n "$v" ]] && protected="$protected$v "
done
alive() { # <version> — installed, being ported right now, or held by a fresh lock
  [[ -f "$VERSIONS/$1" ]] && return 0
  case "$protected" in *" $1 "*) return 0;; esac
  return 1
}
pruned=""
for dir in "$LOCAL"/*/; do
  v="$(basename "$dir")"
  [[ -d "$dir" ]] && ! alive "$v" && { rm -rf "$dir"; pruned="$pruned patches-local/$v"; }
done
for entry in "$STATE"/*; do
  v="$(basename "$entry" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [[ -e "$entry" && -n "$v" ]] && ! alive "$v" &&
    { rm -rf "$entry"; pruned="$pruned $(basename "$entry")"; }
done
# Our own leftovers in the versions directory, 270 MB apiece, once the version
# they belong to is gone: .orig, .patched, and the .new or .lock a crashed
# promotion can leave. The newest .orig survives even orphaned — it is the
# previous bundle the port agent diffs against when a patch drifts.
newest_orig="$(ls "$VERSIONS" 2>/dev/null | grep '\.orig$' | sort -V | tail -1)"
for sibling in "$VERSIONS"/*.orig "$VERSIONS"/*.patched "$VERSIONS"/*.new "$VERSIONS"/*.lock; do
  name="$(basename "$sibling")"
  v="$(echo "$name" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
  [[ -e "$sibling" && -n "$v" && "$name" != "$newest_orig" ]] && ! alive "$v" &&
    { rm -rf "$sibling"; pruned="$pruned $name"; }
done
[[ -n "$pruned" ]] && say "pruned state for uninstalled versions:$pruned"

# A watcher event can fire while the updater is still writing the binary — not
# a failed port, so no agent escalation and no 24-hour damper: exit quietly and
# let the next versions-directory event retry. But a binary that still cannot
# run an hour after it last changed is not mid-install: a corrupted download or
# a poisoned code signature stays broken forever, and earns the failure marker
# and its notification. The .orig backup guard in apply-display-patches.sh
# stays as the last line of defense. One exception: the installer sometimes
# creates the versions/ entry and never writes into it (anthropics/claude-code
# #85900). An entry still empty ten minutes later is that, not a slow download,
# so trash it and reinstall the version — the versions watcher re-fires this port
# when the real binary lands. Once per version: a second empty file means the
# installer keeps failing, which needs a human.
if ! "$BIN" --version >/dev/null 2>&1; then
  [[ ! -e "$BIN" ]] && fail "$BIN does not exist — stale ~/.local/bin/claude symlink?"
  if [[ "$(file_size "$BIN")" == 0 && -n "$(find "$BIN" -maxdepth 0 -mmin +10 2>/dev/null)" ]]; then
    [[ -e "$STATE/$VER.reinstalled" ]] &&
      fail "$VER is still an empty file after reinstalling it — the installer keeps failing (anthropics/claude-code#85900); delete $BIN and run 'claude install $VER' by hand"
    touch "$STATE/$VER.reinstalled"
    say "$VER is an empty file ten minutes after install — trashing it and reinstalling"
    trash "$BIN" || fail "could not trash the empty $BIN"
    "$(best_patched "$BIN")" install "$VER" || say "claude install $VER exited nonzero — the next installer attempt gets another try"
    exit 0
  fi
  [[ -n "$(find "$BIN" -maxdepth 0 -mmin +60 2>/dev/null)" ]] &&
    fail "$VER still cannot execute an hour after install — broken download or poisoned signature?"
  say "$VER does not execute yet — still being installed; not porting"
  exit 0
fi

CAND="$WORK/claude-$VER"
if ! "$ROOT/apply-display-patches.sh" "$VER" "$CAND" > "$WORK/apply.log" 2>&1; then
  tail -20 "$WORK/apply.log"
  if ! is_porter; then
    # Once the porter has promoted this version (or a newer one) with the
    # committed patch set, no re-anchor is coming and waiting would never end:
    # the build fails for a reason local to this machine.
    ported="$(<"$ROOT/ported")"
    if [[ "$(printf '%s\n' "$ported" "$VER" | sort -V | head -1)" == "$VER" ]]; then
      trash_existing "$STATE/$VER.waiting" || exit 1
      fail "$(<"$ROOT/porter") already ported $ported, so no re-anchor for $VER is coming; the build failed here with: $(grep -m1 '^ERROR' "$WORK/apply.log" || tail -1 "$WORK/apply.log")"
    fi
    trash_existing "$STATE/$VER.failed" "$STATE/$VER.escalated" || exit 1
    { damper_fingerprint
      date '+%F %T'; } > "$STATE/$VER.waiting"
    say "waiting for $(<"$ROOT/porter") to port $VER"
    exit 0
  fi
  [[ -z "$(git -C "$ROOT" status --porcelain -- patches/)" ]] ||
    fail "patches/ has uncommitted changes — the port agent cannot re-anchor over them"
  say "patches do not apply cleanly — escalating to the port agent"
  "$ROOT/port-agent.sh" "$VER" "$WORK/apply.log" || say "the port agent exited nonzero"
  AGENT_EDITED=1
  "$ROOT/apply-display-patches.sh" "$VER" "$CAND" > "$WORK/apply.log" 2>&1 ||
    { tail -20 "$WORK/apply.log"; fail "the patch set still does not apply after re-anchoring"; }
fi
cat "$WORK/apply.log"
chmod +x "$CAND"

DROPPED="$(cat "$LOCAL/$VER/dropped" 2>/dev/null | tr '\n' ' ')"
STOCK_LOG=""
SUSPECT=""
if is_porter; then
  # Patches not in this machine's effective set (default-off ones never enabled,
  # or locally disabled) get their suite tests skipped the same way dropped
  # per-version patches do — but only real per-version drops belong in the
  # promotion banner.
  EFFECTIVE="$("$ROOT/apply-display-patches.sh" --print-ids)"
  SKIPPED="$DROPPED"
  for id in $(basename -s .mjs "$ROOT/patches/"*.mjs); do
    case " $EFFECTIVE " in *" $id "*) ;; *) SKIPPED="$SKIPPED $id";; esac
  done
fi
"$CAND" --version >/dev/null 2>&1 || fail "the candidate does not report a version"
SMOKE="$("$CAND" -p --model sonnet "reply with the single word ok" 2>&1)" ||
  { echo "$SMOKE" | tail -5; fail "the candidate cannot complete a prompt"; }

if is_porter; then
  "$ROOT/tests/run-all.sh" "$CAND" $SKIPPED || fail "the functional suite did not pass"

  # The same suite against the stock binary. Every test is meant to fail here —
  # a test that passes has lost its discrimination, which means one of:
  # Anthropic shipped the behavior natively, the assertion drifted vacuous and
  # its pass on the candidate proves nothing, or a flake. The per-test reasons
  # are kept because they carry the mirror case too: a test asserting a patch
  # artifact can never pass on stock even once Anthropic fixes the underlying
  # behavior. The advisory agent classifies; the port just records.
  STOCK_LOG="$STATE/stock-suite-$VER.log"
  "$ROOT/tests/run-all.sh" "$VERSIONS/$VER.orig" $SKIPPED > "$STOCK_LOG" 2>&1
  SUSPECT="$(awk '$1=="pass"{printf "%s ", $2}' "$STOCK_LOG")"
  [[ -n "$SUSPECT" ]] && say "suspect — these tests also pass on stock $VER: $SUSPECT"
fi

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
# The escalation marker goes with the failure marker, so a later regression on
# this version can escalate again.
trash_existing "$STATE/$VER.failed" "$STATE/$VER.escalated" "$STATE/$VER.waiting" || exit 1

if is_porter; then
  PATCH_FILES="$(git -C "$ROOT" diff --name-only -- patches/)"
  if [[ "$AGENT_EDITED" == 1 && -n "$PATCH_FILES" ]]; then
    PATCH_IDS="$(printf '%s\n' "$PATCH_FILES" | sed 's#^patches/##; s/\.mjs$//' | tr '\n' ' ' | sed 's/ $//')"
    git -C "$ROOT" add -- $PATCH_FILES || fail "could not stage the port agent's patch edits"
    if ! git -C "$ROOT" commit -m "Re-anchor $PATCH_IDS for Claude Code $VER" \
      -m "The port agent re-anchored these patches, and the functional suite gated them." \
      -m "Co-Authored-By: Claude <noreply@anthropic.com>" -- $PATCH_FILES; then
      git -C "$ROOT" reset -- patches/
      fail "could not commit the port agent's patch edits"
    fi
  fi
  # `ported` tells consumers which version the committed patch set is known to
  # fit, so a consumer whose apply still fails stops waiting for a re-anchor.
  # Only a clean patches/ certifies that, and only a newer version moves the
  # record: a re-port of an older version must not roll it back.
  if [[ -z "$(git -C "$ROOT" status --porcelain -- patches/)" &&
        "$(printf '%s\n' "$(<"$ROOT/ported")" "$VER" | sort -V | tail -1)" == "$VER" &&
        "$(<"$ROOT/ported")" != "$VER" ]]; then
    echo "$VER" > "$ROOT/ported"
    git -C "$ROOT" commit --quiet -m "Ported Claude Code $VER" -- ported ||
      { git -C "$ROOT" checkout -- ported; fail "could not commit the ported record"; }
  fi
  # Promotion is already done, so a machine that cannot reach origin keeps its
  # patched binary; unpushed commits go with the next port's push.
  git -C "$ROOT" push --quiet origin master || say "could not push to origin"
fi

say "$VER promoted${DROPPED:+ (dropped:$DROPPED)}${SUSPECT:+ (suspect:$SUSPECT)} — restart sessions to pick it up"

# Advisory pass. Promotion is already done, so a slow or failed review costs
# nothing. Only the porter reviews the shared JavaScript patch set.
if is_porter; then
  "$ROOT/advisory-agent.sh" "$VER" "$STOCK_LOG" ||
    say "the advisory agent exited nonzero — see $STATE/advisory-$VER.log"
fi
