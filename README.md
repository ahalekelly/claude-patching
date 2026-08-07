# claude-patching

Patches for the native Claude Code binary: display patches, a prompt-size patch, a sticky-header patch, a task-reminder patch, and a per-subagent MCP patch.

The display patches make the normal (typeable) chat view show transcript-level tool detail: individual Read/Grep/Glob calls and ToolSearch calls. Claude Code has no setting for this — the only built-in options are collapsed one-liners or full `verbose` — so the binary is patched directly. Thinking display is intentionally left stock (`showThinkingSummaries: true` in settings.json streams summaries while thinking, collapsing to a pill after); upstream's thinking-visibility/thinking-no-fold patches would pin thinking permanently inline.

The sticky-header patch, `sticky-prompt-header.mjs` (local, not from the upstream repo), changes the one-line header above the transcript that shows the previous prompt: stock Claude Code renders it only while scrolled up, in grey-on-grey; patched, it shows whenever the prompt has scrolled off the top (including while following live output) and renders in bold theme text color. Click-to-jump is unchanged.

The task-reminder patch, `task-reminder-conditional.mjs` (local, not from the upstream repo), gates the periodic "The task tools haven't been used recently..." system reminder on the session's task list being non-empty. Stock Claude Code injects it on a timer (~100 tokens, several times per session) whether or not task tracking is in use; patched, it only fires when tasks exist but have gone unattended. Upstream's `system-reminders` patch offers only keep/concise/remove for this reminder; the conditional keeps it where it's useful.

The per-subagent MCP patch, `mcp-per-subagent.mjs` (local, not from the upstream repo), gives each subagent its own process for the stdio MCP servers its frontmatter declares inline. Stock Claude Code memoizes MCP connections on a hash of the server config, so two subagents declaring byte-identical inline servers share one server process and one session — and whichever finishes first tears it down under the other ([anthropics/claude-code#84638](https://github.com/anthropics/claude-code/issues/84638)). The patch injects a per-invocation slot number into the config's `env`, which both makes the memo key unique and reaches the spawned process, so every per-agent server also sees `CLAUDE_MCP_PER_AGENT=1` — a canary a server can read to tell a patched harness from a stock one. Named (string) frontmatter specs and http/sse servers are left on the shared connection. `tests/mcp-per-subagent/run.sh` proves the behavior end to end against a given binary.

The prompt-size patch, `defer-tool-descriptions.mjs` (local, not from the upstream repo), replaces the Workflow and Artifact tool descriptions — ~6.5k standing tokens in every session's system prompt — with short stubs that point at the `workflow-tool` and `artifact-tool` skills in `~/.agents/skills/`, which hold the full original text. Sessions only pay for the full guidance when they actually use those tools. When a Claude Code update changes those descriptions, the patch fails loudly on both layout drift (anchors moved) and content drift (each target's literal is checked against a stored sha256 of the text the SKILL.md snapshots were taken from): refresh the two SKILL.md files to match the new text, then update the hashes in the script — the failure message prints the new values.

## Launching and porting

One rule governs every launch: **run the best available patched binary now, reconcile in the background.** The `_claude_with_profile` wrapper in `~/.agents/home/.zshrc` runs `check-and-apply.sh`, which writes the binary to launch into a target file and returns immediately. A launch never waits on a 272 MB unpack and repack, and a Claude Code update never drops the session back to stock while a patched binary of the previous version exists.

Resolution order: the newest installed version if its stamp is valid (the silent fast path), else the newest binary in the archive, else stock. In the last two cases the check prints why, spawns the background port, and exits 1 so the wrapper holds for an Enter before the TUI wipes the message. It also warns when the archived binary it just launched is more than three releases or seven days behind the installed one, since silent indefinite fallback is this design's main risk.

The port itself runs detached. It applies the patch set mechanically first, escalates to a headless Opus session (`port-agent.sh`) only when a patch no longer applies, and then puts the candidate through the functional suite. **Only a candidate that passes is promoted** — the agent never touches the live launch path. A failed port writes `patches-local/<ver>.failed` and is not retried for 24 hours or until the patch repo pulls new commits, so a broken version can't respawn an agent on every launch. Promotion takes the same lock a launch takes, writes every file new and moves it into place, relinks the app bundle, and leaves a note the next launch prints along with a desktop notification.

The stamp file `<binary>.patched` holds the patched binary's inode, size, and mtime plus a fingerprint of every input that decides the patched bytes, so a binary replaced underneath it — an update reinstalling the same version, a manual restore — or a change to the patches themselves fails the check and gets reconciled instead of being trusted as patched.

- `check-and-apply.sh <target-file>` — pre-launch check: stamp fast path, archive fallback, staleness warning, background port. Exit 0 = silent, exit 1 = printed something the wrapper should hold for. Exits immediately when `CLAUDE_PATCHING_AUTOPORT` is set, so the port's own sessions never recurse.
- `background-port.sh [version]` — the reconciler: lock, `git pull`, mechanical apply, agent escalation, gate (`--version`, a trivial prompt, `tests/run-all.sh`), promotion, notification.
- `port-agent.sh <version> <apply-log>` — the escalation: a headless Opus session in auto permission mode whose only output is `patches-local/<version>/`.
- `apply-display-patches.sh <version> <output-binary>` — pure candidate builder: unpacks `versions/<version>.orig` (backing it up on first sight), applies the patches listed in its header, checks the result parses, repacks to the output path. Fails loudly, writing nothing, if any patch doesn't match.
- `tests/` — a behavioral test per applied patch. See below.
- `patches-local/` — machine-local overlay of `repo/patches/`, written by the port: an `index.json` per version upstream hasn't covered, re-anchored patch files at the paths they occupy upstream, `<ver>/dropped` for patches whose anchors drifted past repair, plus the port's locks, logs and failure markers.
- `repo/` — clone of [phate45/claude-patching](https://github.com/phate45/claude-patching), the patch source. Its own ELF pipeline is Linux-only; only its per-version patch scripts are used here. Triangular remotes: `pull` tracks upstream (phate45), `push` goes to the [ahalekelly/claude-patching](https://github.com/ahalekelly/claude-patching) fork (`origin`) — branch work for upstream PRs happens in the fork.
- `node_modules/` — [tweakcc](https://github.com/Piebald-AI/tweakcc), used for macOS Mach-O unpack/repack.

## Tests

Anchor counts and `node --check` catch layout drift but not semantic drift: a patch can apply cleanly to a lookalike site and quietly do nothing. `tests/run-all.sh <binary> [dropped-id ...]` therefore asserts each patch's *behavior* against a candidate, and is what gates promotion. Run it against a stock binary as the negative control — every test must fail there, or it isn't discriminating.

- `capture_proxy.py` — stands in for the API: records every request and answers from a canned script, so tests are hermetic and cost no tokens.
- `proxy-suite.py <binary> <id>` — asserts on outgoing payloads (system prompt, tool schemas).
- `pty-suite.py <binary> <id>` — drives the TUI under a [pyte](https://github.com/selectel/pyte) screen and asserts on rendered rows, for the patches whose point is what gets drawn.
- `mcp-per-subagent/run.py <binary>` — the one test that needs a live model: two concurrent subagents with byte-identical inline `mcpServers` must produce two server processes, five calls each, all carrying `CLAUDE_MCP_PER_AGENT=1`.

`run-all.sh` names any patch it has no behavioral test for rather than counting it as passing.

## Repatches and already-running processes

A repatch only changes the file on disk; every claude process keeps the JS it loaded at start. Two consequences beyond the obvious "restart your sessions":

- **The daemon's warm spares serve stale code.** The Claude Code daemon pre-forks spare processes (`claude bg-spare` + `bg-pty-host` pairs under `/tmp/cc-daemon-501/<daemon>/spare/`) that load the binary's JS at fork time. Daemon-launched sessions (desktop app, FleetView) claim a spare on start, so a session "restarted" right after a repatch can still run pre-patch code — repeatedly, until the pool cycles. Diagnose with `ps -axo pid,lstart,command | grep bg-spare` and compare spare fork times against the binary mtime; killing stale unclaimed spares is safe, the daemon reforks fresh ones. Terminal launches via the zsh wrapper exec the binary directly and never touch the spare pool.
- **The inode swap can kill live sessions.** Sessions launched from the replaced inode may die when the binary is swapped underneath them; they resume cleanly, but a repatch mid-conversation is what that crash was.

To verify a patch's behavior end to end without trusting a user report, drive the TUI in a scripted PTY: spawn the binary under `pty.fork()` with a [pyte](https://github.com/selectel/pyte) screen emulator, send a prompt, push it off-screen with `!seq 1 300` (local bash, no model tokens), and assert on the rendered rows.

## Restoring the stock binary

macOS caches a Mach-O's code signature per inode, so overwriting the live binary in place leaves the kernel SIGKILLing (`exit 137`) every launch of that inode even when the bytes are byte-for-byte correct. Always write a new file and rename it into place, then relink the app bundle:

```bash
cd ~/.local/share/claude/versions
cp <ver>.orig <ver>.new && mv <ver>.new <ver>
ln -f <ver> ~/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
trash <ver>.patched
```

A binary already poisoned this way is only recoverable by replacing it through a fresh inode the same way — the file itself is fine, the kernel's cached verdict for that inode is not.
