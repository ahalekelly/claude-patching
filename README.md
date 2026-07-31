# claude-patching

Display patches for the native Claude Code binary, making the normal (typeable) chat view show transcript-level detail: inline thinking, individual Read/Grep/Glob calls, Read line ranges, and ToolSearch calls. Claude Code has no setting for this — the only built-in options are collapsed one-liners or full `verbose` — so the binary is patched directly.

Patching is automatic: the `_claude_with_profile` wrapper in `~/.agents/home/.zshrc` runs `check-and-apply.sh` before every launch. An already-patched binary (stamp file `<binary>.patched`) costs one stat and launches immediately; after a Claude Code update the wrapper repatches first, so the new session runs the patched binary. Whenever the check prints anything — repatched, patch set not ported upstream yet, failure — the wrapper waits for Enter before the TUI can wipe the message. Launches that bypass the wrapper (desktop app, daemons) run whatever state the binary is in.

- `check-and-apply.sh` — pre-launch check: stamp fast path, concurrent-launch lock, `git pull` of the patch repo when a new version's patch set is missing, then `apply-display-patches.sh`. Exit 0 = silent/patched, exit 1 = printed something the wrapper should hold for.
- `apply-display-patches.sh` — unpacks the JS from the binary, applies the five display patches, backs up the stock binary to `<binary>.orig`, repacks, writes the `.patched` stamp. Fails loudly (binary untouched) if any patch doesn't match the installed version.
- `repo/` — clone of [phate45/claude-patching](https://github.com/phate45/claude-patching), the patch source. `git -C repo pull` when a new Claude Code version needs a newer patch set. Its own ELF pipeline is Linux-only; only its per-version patch scripts are used here.
- `node_modules/` — [tweakcc](https://github.com/Piebald-AI/tweakcc), used for macOS Mach-O unpack/repack.

Restore stock binary: `cp ~/.local/share/claude/versions/<ver>.orig ~/.local/share/claude/versions/<ver>`
