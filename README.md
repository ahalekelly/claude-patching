# claude-patching

Display patches for the native Claude Code binary, making the normal (typeable) chat view show transcript-level detail: inline thinking, individual Read/Grep/Glob calls, Read line ranges, and ToolSearch calls. Claude Code has no setting for this — the only built-in options are collapsed one-liners or full `verbose` — so the binary is patched directly.

- `apply-display-patches.sh` — unpacks the JS from the binary, applies the five display patches, backs up the stock binary to `<binary>.orig`, repacks. Run it after every Claude Code update. Fails loudly (binary untouched) if any patch doesn't match the installed version.
- `repo/` — clone of [phate45/claude-patching](https://github.com/phate45/claude-patching), the patch source. `git -C repo pull` when a new Claude Code version needs a newer patch set. Its own ELF pipeline is Linux-only; only its per-version patch scripts are used here.
- `node_modules/` — [tweakcc](https://github.com/Piebald-AI/tweakcc), used for macOS Mach-O unpack/repack.

Restore stock binary: `cp ~/.local/share/claude/versions/<ver>.orig ~/.local/share/claude/versions/<ver>`
