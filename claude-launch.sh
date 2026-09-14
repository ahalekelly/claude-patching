#!/usr/bin/env bash
# Launch Claude Code on the best available patched binary: the executable form
# of the `claude` shell function, which can simply call this script. It is for
# launchers that spawn Claude Code by name or path and so never reach a shell
# function — T3 Code (its Claude provider's binary path setting), the Agent SDK,
# any script. The child's stdout is the session's stream, so this script writes
# nothing there. The fallback is the installer's symlink, never bare `claude`,
# which a PATH lookup could resolve to this script.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Nonzero exit = the check printed something worth reading; hold for Enter
# before the TUI takes over.
if ! target="$("$ROOT/check-and-apply.sh")" && [[ -t 0 && -t 1 ]]; then
  printf 'Press Enter to launch Claude Code... ' >&2
  read -r
fi
exec "${target:-$HOME/.local/bin/claude}" "$@"
