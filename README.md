# claude-patching

Patches for the native Claude Code binary: display patches, a prompt-size patch, and a sticky-header patch.

The display patches make the normal (typeable) chat view show transcript-level tool detail: individual Read/Grep/Glob calls, Read line ranges, and ToolSearch calls. Claude Code has no setting for this — the only built-in options are collapsed one-liners or full `verbose` — so the binary is patched directly. Thinking display is intentionally left stock (`showThinkingSummaries: true` in settings.json streams summaries while thinking, collapsing to a pill after); upstream's thinking-visibility/thinking-no-fold patches would pin thinking permanently inline.

The sticky-header patch, `sticky-prompt-header.mjs` (local, not from the upstream repo), changes the one-line header above the transcript that shows the previous prompt: stock Claude Code renders it only while scrolled up, in grey-on-grey; patched, it shows whenever the prompt has scrolled off the top (including while following live output) and renders in bold theme text color. Click-to-jump is unchanged.

The prompt-size patch, `defer-tool-descriptions.mjs` (local, not from the upstream repo), replaces the Workflow and Artifact tool descriptions — ~6.5k standing tokens in every session's system prompt — with short stubs that point at the `workflow-tool` and `artifact-tool` skills in `~/.agents/skills/`, which hold the full original text. Sessions only pay for the full guidance when they actually use those tools. When a Claude Code update changes those descriptions, the patch fails loudly on both layout drift (anchors moved) and content drift (each target's literal is checked against a stored sha256 of the text the SKILL.md snapshots were taken from): refresh the two SKILL.md files to match the new text, then update the hashes in the script — the failure message prints the new values.

Patching is automatic: the `_claude_with_profile` wrapper in `~/.agents/home/.zshrc` runs `check-and-apply.sh` before every launch. An already-patched binary costs one stat and launches immediately; after a Claude Code update the wrapper repatches first, so the new session runs the patched binary. Whenever the check prints anything — repatched, patch set not ported upstream yet, failure — the wrapper waits for Enter before the TUI can wipe the message. Launches that bypass the wrapper (desktop app, daemons) run whatever state the binary is in, though patching relinks the app bundle so both paths share the patched binary.

The stamp file `<binary>.patched` holds the patched binary's inode, size, and mtime plus a fingerprint of the patch set, so a binary replaced underneath it — an update reinstalling the same version, a manual restore — or a change to the patches themselves fails the check and gets repatched instead of being trusted as patched.

- `check-and-apply.sh` — pre-launch check: stamp fast path, concurrent-launch lock, `git pull` of the patch repo when a new version's patch set is missing, then `apply-display-patches.sh`. Exit 0 = silent/patched, exit 1 = printed something the wrapper should hold for.
- `apply-display-patches.sh` — backs up the stock binary to `<binary>.orig` on first run and always rebuilds from that backup, so re-running on an already-patched binary is safe: unpacks the JS, applies the patches listed in its header, repacks, relinks the app bundle, writes the `.patched` stamp. Fails loudly (binary untouched) if any patch doesn't match the installed version.
- `repo/` — clone of [phate45/claude-patching](https://github.com/phate45/claude-patching), the patch source. `git -C repo pull` when a new Claude Code version needs a newer patch set. Its own ELF pipeline is Linux-only; only its per-version patch scripts are used here.
- `node_modules/` — [tweakcc](https://github.com/Piebald-AI/tweakcc), used for macOS Mach-O unpack/repack.

## Restoring the stock binary

macOS caches a Mach-O's code signature per inode, so overwriting the live binary in place leaves the kernel SIGKILLing (`exit 137`) every launch of that inode even when the bytes are byte-for-byte correct. Always write a new file and rename it into place, then relink the app bundle:

```bash
cd ~/.local/share/claude/versions
cp <ver>.orig <ver>.new && mv <ver>.new <ver>
ln -f <ver> ~/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
trash <ver>.patched
```

A binary already poisoned this way is only recoverable by replacing it through a fresh inode the same way — the file itself is fine, the kernel's cached verdict for that inode is not.
