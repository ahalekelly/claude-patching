# claude-patching

Twelve patches for the **native Claude Code binary** on macOS, each covered by a behavioral test, plus a port that keeps them applied across updates without ever making you wait for it.

Claude Code ships as a single-file Mach-O with its JavaScript bundled inside. Several things it does — collapsing tool calls, hiding ToolSearch and cron fires, spending thousands of standing prompt tokens on tool descriptions you rarely use, sharing one MCP server process between concurrent subagents — have no setting. So the bundle is unpacked, patched, and repacked.

Two properties make that safe enough to run every day:

- **Every patch refuses rather than guesses.** Anchors are content-bearing (property names, string literals, tool-name constants — never a bare control-flow shape), match counts are asserted exactly, and edits splice by index. A patch that no longer fits aborts the build with the binary untouched.
- **Every patch has a behavioral test.** Anchor counts catch layout drift but not semantic drift: a patch can apply cleanly to a lookalike site and quietly do nothing. `tests/` asserts what the patched binary *does* — what it sends to the API, what it draws on screen — and only a candidate that passes gets promoted.

## The patches

| id | what changes |
| --- | --- |
| `no-collapse-reads` | Read/Grep/Glob calls render individually instead of collapsing into "Read 3 files" |
| `toolsearch-visibility` | ToolSearch calls render with their query instead of being absorbed silently |
| `cron-visibility` | a cron-fired prompt renders in the transcript, and reaches the model prefixed `CronJob:` instead of arriving as an anonymous user turn |
| `tool-defer-whitelist` | tools named in `CLAUDE_CODE_IMMEDIATE_TOOLS` ship their full schema up front instead of being deferred behind ToolSearch |
| `trim-context-bloat` | drops `userEmail`, `currentDate` and the model-family paragraph from the system prompt |
| `defer-workflow-description` | the Workflow tool's ~20k-char description becomes a stub pointing at a `workflow-tool` skill that holds the full text |
| `defer-artifact-description` | the same for the Artifact tool and an `artifact-tool` skill |
| `sticky-prompt-header` | the previous-prompt header above the transcript shows whenever the prompt has scrolled off the top, not only while scrolled up, and in readable contrast |
| `task-reminder-conditional` | the periodic "task tools haven't been used recently" reminder fires only when the session's task list is non-empty |
| `agents-view-shortcut` | a rebindable keybinding action opens the agents view from anywhere; stock offers only left-arrow on an empty idle prompt |
| `mcp-per-subagent` | each subagent gets its own process for the stdio MCP servers its frontmatter declares inline ([#84638](https://github.com/anthropics/claude-code/issues/84638)) |
| `agent-model-display` | the in-session task menu shows each subagent's resolved model, and agents-view job rows show their `--model` flag in the age column ("fable · 3m") |

Each patch is one self-contained script under `patches/`, run as `node patches/<id>.mjs <unpacked-cli.js>`, with a header comment explaining the stock behavior, the anchor, and why the anchor is safe.

`mcp-per-subagent` is behavioral rather than cosmetic and is marked mandatory: it can never be dropped to get a build through.

The two `defer-*-description` patches assume you have a skill holding the original description text — otherwise you are deleting guidance, not deferring it. Snapshot each tool's description into `<skills-dir>/workflow-tool/SKILL.md` and `<skills-dir>/artifact-tool/SKILL.md` before enabling them. They also verify a sha256 of the description text they replace, so an update that rewrites it fails the build and tells you to refresh the snapshot.

`trim-context-bloat` removes the date from the system prompt on the grounds that a date with no time, fixed at session start, is worse than useless in a long session. Pair it with a `UserPromptSubmit` hook that echoes the live date and time.

## Requirements

- macOS, and Claude Code installed natively (`~/.local/bin/claude` → `~/.local/share/claude/versions/<version>`). The npm install is a different shape and is not supported.
- `node`, `python3`, and `jq`.
- [`pyte`](https://github.com/selectel/pyte) for the PTY half of the suite — the tests fetch it themselves if `uv` is installed, since they run under `uv run --script`.
- A logged-in `claude` CLI, for the two agents the port escalates to. Without one, the port still works mechanically; it just cannot re-anchor a patch that has drifted or file an upstream-watch report.

## Install

Clone anywhere, install the one dependency, and point your shell's `claude` at the check:

```bash
git clone https://github.com/ahalekelly/claude-patching.git ~/claude-patching
cd ~/claude-patching && npm ci
```

```bash
# in ~/.zshrc
claude() {
  # Launch the best available patched binary, which check-and-apply.sh names in
  # the target file; a new version is reconciled in the background, so a launch
  # never waits on an unpack and repack. An empty target file falls back to
  # `claude` on PATH. Nonzero exit = the check printed something worth reading;
  # hold for an Enter before the TUI takes over the screen.
  local target="$(mktemp "${TMPDIR:-/tmp}/claude-launch-target.XXXXXX")" bin=claude
  if ! "$HOME/claude-patching/check-and-apply.sh" "$target" && [[ -t 0 && -t 1 ]]; then
    printf 'Press Enter to launch Claude Code... '
    read -r
  fi
  [[ -s "$target" ]] && bin="$(<"$target")"
  rm -f "$target"
  command "$bin" "$@"
}
```

To pick a subset, delete the ids you do not want from `PATCH_IDS` at the top of `apply-display-patches.sh`. Any patch whose id is absent is simply never applied, and `tests/run-all.sh` names it as skipped rather than counting it as passing.

## Launching and porting

One rule governs every launch: **run the best available patched binary now, reconcile in the background.** `check-and-apply.sh` writes the binary to launch into a target file and returns immediately. A launch never waits on a 270 MB unpack and repack, and a Claude Code update never drops the session back to stock while a patched binary of the previous version exists.

Resolution order: the newest installed version if its stamp is valid (the silent fast path), else the newest binary in the archive, else stock. In the last two cases the check prints why, spawns the background port, and exits 1 so the wrapper holds for an Enter before the TUI wipes the message. It also warns when the archived binary it just launched is more than three releases or seven days behind the installed one, since silent indefinite fallback is this design's main risk.

The port itself runs detached, in three tiers:

1. **Mechanical.** Apply the patch set to the new bundle. Usually enough — most releases move nothing a content-bearing anchor depends on.
2. **Re-anchor.** If a patch no longer applies, a Claude agent (`port-agent.sh`) is given the failing output, the previous release's bundle, and [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) — which publishes Claude Code's system prompts per release, minutes after each one — and writes re-anchored patches into `patches-local/<version>/`. Those win over `patches/` for that version only. A patch it cannot repair goes in `patches-local/<version>/dropped` and is skipped, so one cosmetic patch can never pin the machine to an old release.
3. **Gate.** The candidate must report a version, complete a trivial prompt, and pass `tests/run-all.sh`. **Only a candidate that passes is promoted** — the agent never touches the live launch path.

A failed port writes `port-state/<version>.failed` and is not retried for 24 hours or until the patch set itself changes, so a broken version cannot respawn an agent on every launch. Promotion takes the same lock a launch takes, writes every file new and moves it into place, relinks the app bundle, and leaves a note the next launch prints along with a desktop notification.

The stamp file `<binary>.patched` holds the patched binary's inode, size and mtime plus a fingerprint of every input that decides the patched bytes, so a binary replaced underneath it — an update reinstalling the same version, a manual restore — or a change to the patches themselves fails the check and gets reconciled instead of being trusted as patched.

### Files

- `check-and-apply.sh <target-file>` — pre-launch check: stamp fast path, archive fallback, staleness warning, background port. Exit 0 = silent, exit 1 = printed something the wrapper should hold for. Exits immediately when `CLAUDE_PATCHING_AUTOPORT` is set, so the port's own sessions never recurse.
- `background-port.sh [version]` — the reconciler: lock, mechanical apply, agent escalation, gate, stock-suite run, promotion, notification, advisory pass.
- `apply-display-patches.sh <version> <output-binary>` — pure candidate builder: unpacks `versions/<version>.orig` (backing it up on first sight), applies `PATCH_IDS` in order, checks the result parses, repacks to the output path. Fails loudly, writing nothing, if any patch does not match.
- `port-agent.sh` / `advisory-agent.sh` — the two escalations, both launched through `agent-run.sh`: a Claude session in auto permission mode, in a visible Terminal window when a GUI session exists and headless otherwise.
- `patches/` — the committed patch set.
- `patches-local/` — machine-local overlay written by the port: `<version>/<id>.mjs` re-anchors, `<version>/dropped`.
- `port-state/` — locks, logs, failure markers, and the note the next launch prints.

## Tests

`tests/run-all.sh <binary> [dropped-id ...]` asserts each patch's *behavior* against a candidate, and is what gates promotion. It names any patch it has no test for rather than counting it as passing.

- `capture_proxy.py` — stands in for the API: records every request and answers from a canned script, so tests are hermetic and cost no tokens.
- `proxy-suite.py <binary> <id>` — asserts on outgoing payloads (system prompt, tool schemas).
- `pty-suite.py <binary> <id>` — drives the TUI under a [pyte](https://github.com/selectel/pyte) screen and asserts on rendered rows, for the patches whose point is what gets drawn.
- `mcp-per-subagent/run.py <binary>` — the one test that needs a live model: one agent definition launched twice concurrently must produce two server processes with overlapping lifetimes, two initialize handshakes, both carrying `CLAUDE_MCP_PER_AGENT=1`, and a survivor whose late call still succeeds after its sibling's server shuts down.

### Upstream watch

Every port runs the same suite against the stock binary too, where every test is meant to fail. A test that **passes on stock** has lost its discrimination — either Anthropic shipped the behavior natively, or the assertion drifted vacuous and its pass on the candidate proves nothing. Both are worth knowing; neither is decided by the port.

After promotion an advisory agent classifies those, reads the per-test stock failure reasons (a test asserting a patch artifact — the MCP canary, a defer stub's text — can never pass on stock even once Anthropic fixes the underlying problem, so only the reason distinguishes the two), and reviews what [phate45/claude-patching](https://github.com/phate45/claude-patching) has done since the SHA in `port-state/phate45-reviewed`. It recommends and never edits; its report goes into the note the next launch prints.

## Operational notes

### Repatches and already-running processes

A repatch only changes the file on disk; every claude process keeps the JS it loaded at start. Two consequences beyond the obvious "restart your sessions":

- **The daemon's warm spares serve stale code.** The Claude Code daemon pre-forks spare processes (`claude bg-spare` + `bg-pty-host` pairs under `/tmp/cc-daemon-<uid>/<daemon>/spare/`) that load the binary's JS at fork time. Daemon-launched sessions (desktop app, agents view) claim a spare on start, so a session "restarted" right after a repatch can still run pre-patch code — repeatedly, until the pool cycles. Diagnose with `ps -axo pid,lstart,command | grep bg-spare` and compare spare fork times against the binary mtime. Promotion runs `pkill -f -- '--bg-spare'`, which kills unclaimed spares **and** live sessions claimed from spares (their argv keeps `--bg-spare`): every daemon-attached session bounces for a few seconds at promotion and auto-resumes on the new binary. That is the intended trade — promotions are rare and sessions come back patched. Terminal launches via the shell wrapper exec the binary directly and never touch the spare pool.
- **The inode swap can kill live sessions.** Sessions launched from the replaced inode may die when the binary is swapped underneath them; they resume cleanly, but a repatch mid-conversation is what that crash was.

### Restoring the stock binary

macOS caches a Mach-O's code signature per inode, so overwriting the live binary in place leaves the kernel SIGKILLing (`exit 137`) every launch of that inode even when the bytes are byte-for-byte correct. Always write a new file and rename it into place, then relink the app bundle:

```bash
cd ~/.local/share/claude/versions
cp <ver>.orig <ver>.new && mv <ver>.new <ver>
ln -f <ver> ~/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
trash <ver>.patched
```

A binary already poisoned this way is only recoverable by replacing it through a fresh inode the same way — the file itself is fine, the kernel's cached verdict for that inode is not.

## Credits

[phate45/claude-patching](https://github.com/phate45/claude-patching) pioneered patching the native Claude Code binary this way, and is where the ideas behind five of these patches came from. That project carries no license, so nothing here is derived from its code: every patch in `patches/` is an original implementation written against anchors derived independently from the bundle, with its own behavioral test as the contract.

[tweakcc](https://github.com/Piebald-AI/tweakcc) does the Mach-O unpack and repack, and [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) is the port agent's fastest signal on prompt-text drift.

## License

MIT — see [LICENSE](LICENSE).
