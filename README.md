# claude-patching

Patches for the **native Claude Code binary** on macOS and Linux — all applied by default except the ones the table below marks default-off — plus a port that keeps them applied across updates without ever making you wait for it.

Claude Code ships as a single-file executable with its JavaScript bundled inside. Several things it does — collapsing tool calls, hiding ToolSearch and cron fires, spending thousands of standing prompt tokens on tool descriptions you rarely use, sharing one MCP server process between concurrent subagents — have no setting. So the bundle is unpacked, patched, and repacked.

Two properties make that safe enough to run every day:

- **Every patch refuses rather than guesses.** Anchors are content-bearing (property names, string literals, tool-name constants — never a bare control-flow shape), match counts are asserted exactly, and edits splice by index. A patch that no longer fits aborts the build with the binary untouched.
- **Every patch has a behavioral test, or a written excuse.** Anchor counts catch layout drift but not semantic drift: a patch can apply cleanly to a lookalike site and quietly do nothing. `tests/` asserts what the patched binary *does* — what it sends to the API, what it draws on screen — and only a candidate that passes gets promoted. An applied patch with no test fails the gate unless `tests/waivers` names it and says why a test cannot exist yet.

## The patches

| id | what changes |
| --- | --- |
| `no-collapse-tool-calls` | Read/Grep/Glob/Bash calls render individually instead of collapsing into "Read 3 files" or "ran 4 shell commands" |
| `cron-visibility` | a cron-fired prompt renders in the transcript, and reaches the model prefixed `CronJob:` instead of arriving as an anonymous user turn |
| `tool-defer-whitelist` | tools named in `CLAUDE_CODE_IMMEDIATE_TOOLS` ship their full schema up front instead of being deferred behind ToolSearch |
| `trim-context-bloat` | drops `userEmail`, `currentDate` and the model-family paragraph from the system prompt |
| `defer-workflow-description` | the Workflow tool's ~5k-token description becomes a stub pointing at a `workflow-tool` skill that holds the full text |
| `defer-artifact-description` | the same for the Artifact tool's ~1.5k tokens and an `artifact-tool` skill |
| `sticky-prompt-header` | the previous-prompt header above the transcript shows whenever the prompt has scrolled off the top, not only while scrolled up, and in readable contrast |
| `task-reminder-conditional` | the periodic "task tools haven't been used recently" reminder fires only when the session's task list is non-empty |
| `agents-view-shortcut` | a rebindable keybinding action opens the agents view from anywhere; stock offers only left-arrow on an empty idle prompt |
| `mcp-per-subagent` | each subagent gets its own process for the stdio MCP servers its frontmatter declares inline ([#84638](https://github.com/anthropics/claude-code/issues/84638)) |
| `agent-list-models` | the in-session agent list shows each row's model — subagents as "11m 50s · fable · ↓ 92.8k tokens", the main row as a right-aligned "fable · ↓ 12k tokens" |
| `agents-view-models` | agents-view job rows show their `--model` flag in the age column ("fable · 3m") |
| `task-notification-provenance` | agent task-notifications carry a `<trigger>` element naming what started the run — original launch, a user message sent to the agent, a SendMessage, or an auto-resume — so an owner can tell a user-initiated continuation from a rogue one ([#84957](https://github.com/anthropics/claude-code/issues/84957)) |
| `toolsearch-visibility` *(default-off)* | ToolSearch calls render with their query instead of being absorbed silently |
| `thinking-visibility` *(default-off)* | thinking blocks render inline in the normal chat view, expanded; stock shows them only in transcript mode (ctrl+o) or under `--verbose` |
| `thinking-no-fold` *(default-off)* | a thinking block stays its own transcript entry instead of folding into the adjacent collapsed read/search group's "Thought for Ns" pill |
| `thinking-latest` *(default-off)* | the "Thought for Ns" pill shows its group's most recent thinking block in full, streaming and after the turn completes; clicking the pill still opens every block |

Each patch is one self-contained script under `patches/`, run as `node patches/<id>.mjs <unpacked-cli.js>`, with a header comment explaining the stock behavior, the anchor, and why the anchor is safe.

`mcp-per-subagent` is behavioral rather than cosmetic and is marked mandatory: it can never be dropped to get a build through.

`toolsearch-visibility` ships default-off: ToolSearch fires constantly in tool-heavy sessions, and the rows are noise once you trust that deferred tools load. Enable it via `patches-local/enable` when debugging tool discovery.

The three thinking patches ship default-off (stock's stream-then-collapse behavior is a reasonable preference) and offer two mutually exclusive presentations. `thinking-visibility` + `thinking-no-fold` are a pair — enable both via `patches-local/enable` or neither: every thinking block renders as its own inline entry and the "Thought for Ns" pill disappears. Alone, `thinking-no-fold` unfolds thinking into a render path that stock draws as nothing, and `thinking-visibility` barely matters because nearly every thinking block gets folded before it reaches that path. `thinking-latest` is the quieter alternative: the pill stays, always showing only its group's most recent thinking block in full, and clicking it opens the rest. It conflicts with `thinking-no-fold` — with thinking kept out of the groups there is nothing for the pill to show — and the build refuses that combination.

The two `defer-*-description` patches move each tool's description into a skill rather than delete it, so they write that skill themselves: every build renders the original text out of the binary — escapes decoded, interpolated values inlined — and rewrites `~/.claude/skills/workflow-tool/SKILL.md` and `~/.claude/skills/artifact-tool/SKILL.md` in full, frontmatter and preamble included. Edit the patch, not the SKILL.md. When a build changes one it prints `SKILL SNAPSHOT CHANGED` with the path, so an upstream rewrite of a description surfaces as a reviewable diff in your skills directory instead of as guidance silently dropped — anchor drift still aborts the build, snapshot content never does.

`trim-context-bloat` removes the date from the system prompt on the grounds that a date with no time, fixed at session start, is worse than useless in a long session. Pair it with a `UserPromptSubmit` hook that echoes the live date and time.

## Requirements

- macOS or Linux, and Claude Code installed natively (`~/.local/bin/claude` → `~/.local/share/claude/versions/<version>`). The npm install is a different shape and is not supported.
- `node`, `python3`, and `jq`.
- `notify-send` is optional on Linux for desktop notifications.
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

To pick a subset, list ids in two optional machine-local files under gitignored `patches-local/`: `disable` (one id per line) turns off patches from the default set, and `enable` turns on patches that ship default-off. Both count toward the promotion stamp's fingerprint, so editing them triggers a rebuild on the next launch, and the port's gate skips the suite tests of whatever is not applied. `mcp-per-subagent` is mandatory and cannot be disabled.

## Launching and porting

One rule governs every launch: **run the best available patched binary now, reconcile in the background.** `check-and-apply.sh` writes the binary to launch into a target file and returns immediately. A launch never waits on a 270 MB unpack and repack, and a Claude Code update never drops the session back to stock while a patched binary of the previous version exists.

Resolution order: the newest installed version if its stamp is valid (the silent fast path), else the newest binary in the archive, else stock. In the last two cases the check prints why, spawns the background port, and exits 1 so the wrapper holds for an Enter before the TUI wipes the message. It also warns when the archived binary it just launched is more than three releases or seven days behind the installed one, since silent indefinite fallback is this design's main risk.

The port itself runs detached, in three tiers:

1. **Mechanical.** Apply the patch set to the new bundle. Usually enough — most releases move nothing a content-bearing anchor depends on.
2. **Re-anchor.** If a patch no longer applies, a Claude agent (`port-agent.sh`) is given the failing output, the previous release's bundle, and [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) — which publishes Claude Code's system prompts per release, minutes after each one — and writes re-anchored patches into `patches-local/<version>/`. Those win over `patches/` for that version only. A patch it cannot repair goes in `patches-local/<version>/dropped` and is skipped, so one cosmetic patch can never pin the machine to an old release.
3. **Gate.** The candidate must report a version, complete a trivial prompt, and pass `tests/run-all.sh`. **Only a candidate that passes is promoted** — the agent never touches the live launch path.

A failed port writes `port-state/<version>.failed` and is not retried for 24 hours or until the patch set itself changes, so a broken version cannot respawn an agent every time something triggers it. Promotion takes the same lock a launch takes, writes every file new and moves it into place, relinks the macOS app bundle, and leaves a note the next launch prints along with a desktop notification.

The stamp file `<binary>.patched` holds the patched binary's inode, size and mtime plus a fingerprint of every input that decides the patched bytes, so a binary replaced underneath it — an update reinstalling the same version, a manual restore — or a change to the patches themselves fails the check and gets reconciled instead of being trusted as patched.

### Porting on install, not on launch

Claude Code's auto-updater installs new versions on its own schedule, and the daemon spawns background sessions on one the moment it lands — long before your next terminal launch. A launchd agent watches the versions directory and fires the same background port within seconds of an install:

```bash
cp com.akelly.claude-patching.autoport.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.akelly.claude-patching.autoport.plist
```

On Linux, install the equivalent systemd user units:

```bash
cp claude-patching-autoport.{service,path} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now claude-patching-autoport.{path,service}
```

The service runs once at login and on directory changes, has no start timeout, and coalesces triggers while active. Its output goes to the user journal (`journalctl --user -u claude-patching-autoport`), while each port keeps `port-state/port-<version>.log`; edit `ExecStart` if the checkout is elsewhere.

`autoport-trigger.sh` first waits for the new binary's size to hold still, since the watch fires while the updater is still writing it, then takes the same stamp fast path the launch check takes and execs the port only if the stamp fails. launchd requires absolute paths, so edit the plist if your checkout is not at `~/.agents/claude-patching`.

### Files

- `check-and-apply.sh <target-file>` — pre-launch check: stamp fast path, archive fallback, staleness warning, background port. Exit 0 = silent, exit 1 = printed something the wrapper should hold for. Exits immediately when `CLAUDE_PATCHING_AUTOPORT` is set, so the port's own sessions never recurse.
- `background-port.sh [version]` — the reconciler: retry damper, lock, prune of state for uninstalled versions, mechanical apply, agent escalation, gate, stock-suite run, promotion, notification, advisory pass.
- `lib.sh` — shared platform seams and patch-set fingerprint.
- `autoport-trigger.sh` — fired by launchd or systemd on any change to the versions directory: settle wait, stamp fast path, else `exec` the port so the service manager tracks it as the job.
- `com.akelly.claude-patching.autoport.plist` — the launchd agent. Absolute paths, `RunAtLoad` so an install during a logout is caught, `ThrottleInterval` so a burst of writes fires it once.
- `claude-patching-autoport.path` — the systemd user path watcher.
- `claude-patching-autoport.service` — the systemd user service, also started at login.
- `apply-display-patches.sh <version> <output-binary>` — pure candidate builder: unpacks `versions/<version>.orig` (backing it up on first sight), applies `PATCH_IDS` in order, checks the result parses, repacks to the output path and signs it on macOS. Fails loudly, writing nothing, if any patch does not match.
- `port-agent.sh` / `advisory-agent.sh` — the two escalations, both launched through `agent-run.sh`: a Claude session in auto permission mode, in a visible Terminal window when a GUI session exists and headless otherwise. Each step it takes lands in `port-state/<tag>-<version>.log` as it happens — assistant text, a line per tool call, then the final report.
- `setup-signing.sh` — macOS-only, run by hand once: creates the local certificate the port signs patched binaries with.
- `patches/` — the committed patch set.
- `patches-local/` — machine-local overlay written by the port: `<version>/<id>.mjs` re-anchors, `<version>/dropped`.
- `port-state/` — locks, logs, failure markers, the note the next launch prints, and `reanchor-history`: a line per version a patch was carried by a local re-anchor, which the port turns into a "re-anchor debt" line naming each committed patch that has gone stale.

## Tests

`tests/run-all.sh <binary> [dropped-id ...]` asserts each patch's *behavior* against a candidate, and is what gates promotion. What it must cover comes from the patch set actually applied, so a patch with no test fails the run unless `tests/waivers` names it with a reason.

- `capture_proxy.py` — stands in for the API: records every request and answers from a canned script, so tests are hermetic and cost no tokens.
- `proxy-suite.py <binary> <id>` — asserts on outgoing payloads (system prompt, tool schemas).
- `pty-suite.py <binary> <id>` — drives the TUI under a [pyte](https://github.com/selectel/pyte) screen and asserts on rendered rows, for the patches whose point is what gets drawn.
- `mcp-per-subagent/run.py <binary>` — needs a live model: one agent definition launched twice concurrently must produce two server processes with overlapping lifetimes, two initialize handshakes, both carrying `CLAUDE_MCP_PER_AGENT=1`, and a survivor whose late call still succeeds after its sibling's server shuts down.
- `task-notification-provenance/run.py <binary>` — needs a live model: a session launches one background subagent and later resumes it with SendMessage; the first notification in the transcript must attribute the run to the original launch, and the second must name the SendMessage and quote its text.

### Upstream watch

Every port runs the same suite against the stock binary too, where every test is meant to fail. A test that **passes on stock** has lost its discrimination — either Anthropic shipped the behavior natively, or the assertion drifted vacuous and its pass on the candidate proves nothing. Both are worth knowing; neither is decided by the port.

After promotion an advisory agent classifies those, reads the per-test stock failure reasons (a test asserting a patch artifact — the MCP canary, a defer stub's text — can never pass on stock even once Anthropic fixes the underlying problem, so only the reason distinguishes the two), and reviews what [phate45/claude-patching](https://github.com/phate45/claude-patching) has done since the SHA in `port-state/phate45-reviewed`. It recommends and never edits; its report goes into the note the next launch prints.

## Operational notes

### Repatches and already-running processes

A repatch only changes the file on disk; every claude process keeps the JS it loaded at start. Two consequences beyond the obvious "restart your sessions":

- **The daemon's warm spares serve stale code.** The Claude Code daemon pre-forks spare processes (`claude bg-spare` + `bg-pty-host` pairs under `/tmp/cc-daemon-<uid>/<daemon>/spare/`) that load the binary's JS at fork time. Daemon-launched sessions (desktop app, agents view) claim a spare on start, so a session "restarted" right after a repatch can still run pre-patch code — repeatedly, until the pool cycles. Diagnose with `ps -axo pid,lstart,command | grep bg-spare` and compare spare fork times against the binary mtime. Promotion clears both halves of the problem: it kills every unclaimed spare, and every `--bg-pty-host` wrapper along with its direct children, which is how it reaches sessions claimed from a spare — those rewrite their argv to their own resume command and are otherwise unrecognizable. Every daemon-attached session bounces for a few seconds at promotion and auto-resumes on the new binary. That is the intended trade — promotions are rare and sessions come back patched. Terminal launches via the shell wrapper exec the binary directly and never touch the spare pool.
- **The inode swap can kill live sessions on macOS.** Sessions launched from the replaced inode may die when the binary is swapped underneath them; they resume cleanly, but a repatch mid-conversation is what that crash was.

### Code signing and macOS permission prompts

This concern is macOS-only: Linux binaries run unsigned, and `setup-signing.sh` is a no-op there.

macOS keys TCC permissions — automation, accessibility, screen recording — to a binary's signing identity, so an unpatched Claude Code is granted them once as `com.anthropic.claude-code`. A repacked binary cannot keep Anthropic's signature. Every candidate is therefore re-signed under the constant identifier `claude-patched`, with a local certificate when one exists and ad-hoc otherwise.

Ad-hoc is the weak case: with no certificate, the identity is the binary's own hash, so each promotion is an app macOS has never seen and every permission is asked for again. Run `./setup-signing.sh` once, in a real Terminal, to fix that for good — it creates a self-signed `claude-patching` code-signing certificate in your login keychain, trusts it for code signing, and makes its key usable without a dialog so unattended ports can sign with it. It asks for a trust confirmation and your login password, and refuses to claim success if the identity does not come out valid. Expect one final round of permission prompts on the next promotion; after that the grants carry across every one.

### Restoring the stock binary

macOS caches a Mach-O's code signature per inode, so overwriting the live binary in place leaves the kernel SIGKILLing (`exit 137`) every launch of that inode even when the bytes are byte-for-byte correct. Always write a new file and rename it into place, then relink the app bundle:

```bash
cd ~/.local/share/claude/versions
cp <ver>.orig <ver>.new && mv <ver>.new <ver>
ln -f <ver> ~/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
trash <ver>.patched
```

On Linux, the same write-new-then-rename rule avoids `ETXTBSY` on a running binary; there is no app bundle to relink.

A binary already poisoned this way is only recoverable by replacing it through a fresh inode the same way — the file itself is fine, the macOS kernel's cached verdict for that inode is not.

## Credits

[phate45/claude-patching](https://github.com/phate45/claude-patching) pioneered patching the native Claude Code binary this way, and is where the ideas behind five of these patches came from. That project carries no license, so nothing here is derived from its code: every patch in `patches/` is an original implementation written against anchors derived independently from the bundle, with its own behavioral test as the contract.

[tweakcc](https://github.com/Piebald-AI/tweakcc) does the unpack and repack of the single-file executable, and [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) is the port agent's fastest signal on prompt-text drift.

## License

MIT — see [LICENSE](LICENSE).
