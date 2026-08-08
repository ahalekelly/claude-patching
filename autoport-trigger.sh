#!/usr/bin/env bash
# Fired by launchd or systemd on every change to Claude Code's versions
# directory, and once at load. Claude Code's auto-updater installs new versions
# on its own schedule and the daemon starts spawning sessions on them
# immediately, so reconciliation has to be driven by the install rather than by
# the next interactive launch.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/lib.sh"
VERSIONS="$HOME/.local/share/claude/versions"

# Version entries only — the .orig/.patched/.new/.lock siblings share the directory.
VER="$(ls "$VERSIONS" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
[[ -z "$VER" ]] && exit 0
BIN="$VERSIONS/$VER"

# The watch fires while the updater is still writing the 270 MB binary. Wait for
# the size to hold still across two samples; if it never does, give up and let
# the next watch event retry rather than porting a half-written file.
size="$(file_size "$BIN" 2>/dev/null)"
settled=""
for _ in $(seq 12); do
  sleep 5
  next="$(file_size "$BIN" 2>/dev/null)"
  [[ -n "$next" && "$next" == "$size" ]] && { settled=1; break; }
  size="$next"
done
[[ -n "$settled" ]] || exit 0

STAMP="$(file_id "$BIN"; fingerprint)"

[[ -f "$BIN.patched" && "$(<"$BIN.patched")" == "$STAMP" ]] && exit 0

# exec rather than spawn: the service manager owns this pid, so the port it
# becomes is the job it tracks. launchd's ThrottleInterval and systemd's refusal
# to retrigger an active service coalesce bursts of watch events. The port's own
# damper handles a version whose port already failed.
exec "$ROOT/background-port.sh" "$VER" >/dev/null 2>&1
