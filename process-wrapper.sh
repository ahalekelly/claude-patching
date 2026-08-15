#!/usr/bin/env bash
# Claude Code's `processWrapper` / CLAUDE_CODE_PROCESS_WRAPPER argv prefix: the
# background-agent supervisor, the sessions and workers it hosts, and the other
# covered background processes are spawned as
#   process-wrapper.sh <claude-binary> <session-args...>
# and run whichever binary this script execs. Those spawns name the binary by
# absolute path, so they bypass the `claude` shell function and would otherwise
# run a stock build the moment a new version installs. Same selection policy as
# an interactive launch, no messages and no reconcile — the launchd path watcher
# and interactive launches already own that.
#
# Two hard constraints:
#   - The child's stdio is the session's stdio, so nothing may be written to
#     stdout or stderr and the script must end in exec.
#   - A wrapper that fails blocks every background session, which is worse than
#     one unpatched session, so any selection failure falls through to the
#     requested binary.
#
# Claude Code refuses to start background sessions when the first token is an
# absolute path that is not an existing executable file: keep this script
# executable and in place, and keep its path free of spaces.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS="$HOME/.local/share/claude/versions"
BIN="${1:-}"

# The port infrastructure launches binaries directly with CLAUDE_PATCHING_AUTOPORT
# set and must never be redirected; anything outside the versions directory is a
# process we have no substitution policy for.
if [[ -z "${CLAUDE_PATCHING_AUTOPORT:-}" && -f "$BIN" && "$BIN" == "$VERSIONS/"* ]]; then
  selected=""
  # shellcheck source=lib.sh
  source "$ROOT/lib.sh" 2>/dev/null && selected="$(best_patched "$BIN" 2>/dev/null)"
  [[ -n "$selected" && "$selected" != "$BIN" && -x "$selected" ]] && exec "$selected" "${@:2}"
fi

exec "$@"
