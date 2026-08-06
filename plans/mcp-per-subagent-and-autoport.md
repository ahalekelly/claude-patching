# Stage 1 — per-subagent MCP patch + non-blocking auto-port

## Goal

Two coupled changes to `~/.agents/claude-patching`:

1. **`mcp-per-subagent.mjs`** — a local patch giving each subagent its own MCP server process, fixing the dedup bug ([anthropics/claude-code#84638](https://github.com/anthropics/claude-code/issues/84638)), and stamping `CLAUDE_MCP_PER_AGENT=1` into every spawned stdio server's environment as a detectable canary.
2. **Non-blocking auto-port** — a Claude Code update never launches stock again. The wrapper launches the newest *patched* binary immediately and reconciles the new version in the background: a headless Claude re-anchors any drifted patches, a smoke test gates the result, and only a passing candidate is promoted.

Both sit behind the existing `check-and-apply.sh` → `apply-display-patches.sh` pipeline. This stage does not touch browser-swarm.

## Current state (verified 2026-08-06)

- `~/.local/bin/claude` → `versions/2.1.223`, **stock**: no `.orig`, no `.patched`. `2.1.222` is also stock (byte-identical to its `.orig`). Claude Code is running fully unpatched right now.
- An orphan `2.1.220.patched` stamp sits in `versions/` with no `2.1.220` binary: **the updater prunes old versions.** Any fallback binary must be archived outside `versions/`.
- The wrapper (`~/.agents/home/.zshrc`) runs `check-and-apply.sh`, then `_scrub_secrets claude` — `claude` resolves through `PATH` to the symlink, i.e. always the newest installed version. Launching anything else requires passing an explicit path.
- Upstream coverage has collapsed (~13% of July releases got a patch set) while the patches themselves barely drift (0–2 re-anchors per release, often zero; 2.1.220 needed none). Self-porting is cheap; waiting is not.

## Part A — the dedup patch

### Mechanism

MCP connections are memoized (lodash `memoize`) on the connect function, keyed by `` `${serverName}-${sha256(config)}` ``. The key normalizer strips `scope` but **hashes `env`**. Two subagents with byte-identical inline configs therefore hit one memo entry, await the same promise, and share one client.

The subagent path is the only caller that materializes an inline config, at the frontmatter resolver. Injecting a per-invocation value into `env` there makes the memo key unique — that *is* the fix — and because the stdio spawn site ends its environment with `...config.env`, the same injection reaches the child process as the canary. One edit, both jobs.

### Anchor

```
return{name:n,config:{...o,scope:"dynamic"},isNewlyCreated:!0}
```

Match structurally, capturing the minified names:

```
/return\{name:([$\w]+),config:\{\.\.\.([$\w]+),scope:"dynamic"\},isNewlyCreated:!0\}/
```

One occurrence in both 2.1.222 and 2.1.223. Only two literal tokens (`scope:"dynamic"`, `isNewlyCreated:!0`), zero minified identifiers — immune to identifier drift. It sits *upstream* of the two parallel MCP client trees Anthropic currently ships (v1 default, v2 behind `MCP_SDK_GENERATION` or a growthbook flag), so one edit covers both arms and survives the v1 removal. Patching inside either client module would silently miss the live arm.

### Transformation

```js
return{name:$1,config:{...$2,scope:"dynamic",
  ...($2.type==="stdio"||$2.type===void 0&&"command" in $2
     ?{env:{...$2.env,
            CLAUDE_MCP_PER_AGENT:"1",
            CLAUDE_MCP_AGENT_SLOT:"s"+(globalThis.__ccMcpAgentSlot=(globalThis.__ccMcpAgentSlot||0)+1)}}
     :{})},isNewlyCreated:!0}
```

The monotonic slot is deliberate: the real per-subagent id (`agentId`) is *not* in scope here, and threading it in would need a second, identifier-heavy anchor plus a signature change. The resolver runs exactly once per (subagent launch × declared server), so a counter separates connections just as well. Revisit only if the canary must be correlated to a specific subagent from outside the process.

Scope the injection to stdio deliberately. Named (string) frontmatter specs resolve from disk config, are excluded from the subagent cleanup list, and must keep sharing the session connection — per-agent-izing them would leak processes. http/sse servers have no child process, never receive `env`, and re-keying them would fragment OAuth state.

### Guards (house style, loud failure)

Assert before patching; fail with the binary untouched:

- The key normalizer still hashes `env` — its `let{scope:…,configErrorReason:…,...rest}` destructure is present exactly once, **and** no `delete <id>.env` appears in it. If `env` joins the strip list, the patch would still inject the canary while silently no longer separating connections; this guard is what makes that failure loud.
- Both stdio spawn sites still spread `config.env` last — the `CLAUDE_CODE_SESSION_ID:…,CLAUDECODE:"1",...t.env}` shape must match exactly **2** times (v1 + v2). A count of 1 means a tree was removed or restructured; stop. When Anthropic deletes the v1 tree this guard fires by design: that release needs a human (or the port agent, loudly) to re-verify the surviving spawn site and relax the count to 1 — until then the promotion gate pins the machine to the archive, which is the intended failure mode, not a surprise.
- The anchor itself matches exactly once.

### No teardown work

Per-agent clients keep `isNewlyCreated` true, so the subagent runner's `finally` closes each one; the client's `onclose` evicts its own cache entries, and the process-exit killer still catches hard kills. No refcounting to add.

### Adjacent bugs — do not fix here

The same site holds two more defects, both to be added to #84638 as a follow-up: the shared client is registered in *both* subagents' cleanup lists (the first to finish kills the sibling's server), and stripping `scope` lets a subagent's inline server hash identically to a main-session server, so the subagent adopts and then closes it. This patch makes both unreachable for stdio inline servers by construction; do not attempt separate fixes.

### Starting point

A dry-run-verified draft is committed at `plans/mcp-per-subagent.mjs.draft` (applies cleanly and passes `node --check` on both 2.1.222 and 2.1.223). Treat it as a convenience, not the spec: it implements the anchor, the destructure guard, and the spawn-site count, but **not** the `delete <id>.env` clause of the normalizer guard — add that. This document is the spec.

### Wiring

- Add `mcp-per-subagent.mjs` to `apply-display-patches.sh` alongside the other local patches, and to its header comment block.
- Local patches resolve per version: `patches-local/<ver>/<name>.mjs` if present, else `$ROOT/<name>.mjs`. The `$ROOT` copy is the canonical patch; a per-version copy exists only when Part B's port agent had to re-anchor it.
- Replace the duplicated hardcoded stamp `cat` lists in `apply-display-patches.sh` and `check-and-apply.sh` with the same expression in both: `apply-display-patches.sh` itself, a sorted glob of `$ROOT/*.mjs` and `patches-local/$VER/*`, and `repo/patches/$VER/index.json`. Hashing that superset (not just the resolved files) keeps the two scripts trivially identical, ends the manual stay-in-sync requirement, and still invalidates the stamp whenever any input — including a re-anchored per-version copy — changes.

## Functional test suite — every patch, end to end

Anchor counts and `node --check` catch layout drift but not semantic drift: a patch can apply cleanly to a lookalike site, or to a site whose surrounding semantics changed, and misbehave with every mechanical signal green. So every patch we apply gets a behavioral test in `tests/` asserting the patched *behavior*, not the patch's application. Two harness patterns cover all eleven:

- **Capture-proxy** — launch the candidate headless with `ANTHROPIC_BASE_URL` pointed at a local server that records every API request and replays canned responses. Assertions run on the outgoing payloads (system prompt, tool schemas, message stream): hermetic, deterministic, zero tokens. If the CLI refuses to run against the proxy for some patch (auth entanglement), fall back to a PTY assertion for that patch and note it loudly.
- **pyte PTY** — drive the interactive TUI in a pseudo-terminal, assert on rendered rows (send a prompt, push it off-screen with a local `!seq 1 300`, assert). For patches whose point is what gets drawn. PTY tests should also point at the capture-proxy for responses so they stay hermetic too.

Per-patch assertions:

| patch | harness | asserts |
|---|---|---|
| no-collapse-reads | PTY | parallel Read/Grep/Glob calls render as individual lines, never "Read N files" |
| toolsearch-visibility | PTY | a ToolSearch call renders a visible line |
| quiet-notifications | proxy | a task notification for output already read via TaskOutput does not re-carry that output |
| cron-visibility | PTY + proxy | a cron-fired prompt renders with the CronJob prefix, and the prefix reaches the outgoing user message |
| tool-defer-whitelist | proxy | tools named in `CLAUDE_CODE_IMMEDIATE_TOOLS` ship full schemas in the first request instead of deferred stubs |
| worktree-dedup | proxy | launched from a worktree, duplicated CLAUDE.md/rules content appears once in the system prompt |
| trim-context-bloat | proxy | userEmail, currentDate, and the model-family paragraph are absent from the system prompt |
| defer-tool-descriptions | proxy | Workflow/Artifact tool descriptions are the short skill-pointer stubs |
| sticky-prompt-header | PTY | with the prompt scrolled off-screen, the header row renders, styled as a user message |
| task-reminder-conditional | proxy | no task_reminder when the session task list is empty; present when non-empty |
| mcp-per-subagent | live sessions | the `tests/mcp-per-subagent/` fixture finished per its README: two concurrent agents with byte-identical inline `mcpServers` produce two server PIDs, five calls each, `CLAUDE_MCP_PER_AGENT=1` in each child's env |

A runner — `tests/run-all.sh <binary>` — runs the suite against a given binary and prints per-test pass/fail. The promotion gate and the negative control both go through it. The **negative control** is part of the suite's definition of done: run against a stock binary, every test must *fail*, proving each test discriminates rather than vacuously passing.

## Part B — non-blocking auto-port

### Launch rule

One rule replaces synchronous patch-on-launch:

> Launch the best available patched binary now. Reconcile in the background.

Resolution order:

1. Newest installed version has a valid `.patched` stamp → launch it (silent fast path, unchanged).
2. Otherwise, an archived patched binary exists → launch the newest archived one and spawn the background port for the newest installed version.
3. Otherwise (no patched binary anywhere, e.g. today) → launch stock with a message, and spawn the background port.

This makes *all* patching asynchronous, including when a patch set already exists — one code path, and no launch ever blocked on a 272 MB unpack/repack.

### Wrapper contract

`check-and-apply.sh <target-file>` writes the absolute path of the binary to launch into `<target-file>`. Message and exit-code semantics are unchanged (exit 1 = printed something, wrapper holds for Enter on interactive launches).

```zsh
_claude_with_profile() {
  local target="$(mktemp "${TMPDIR:-/tmp}/claude-launch-target.XXXXXX")" bin=claude
  if ! "$HOME/.agents/claude-patching/check-and-apply.sh" "$target" && [[ -t 0 && -t 1 ]]; then
    printf 'Press Enter to launch Claude Code... '
    read -r
  fi
  [[ -s "$target" ]] && bin="$(<"$target")"
  rm -f "$target"
  CLAUDE_CONFIG_DIR="$1" _scrub_secrets "$bin" "${@:2}"
}
```

A missing or empty target file falls back to `claude` on `PATH`, so a hard failure in the check degrades to today's behavior.

### Archive

Patched binaries are archived to `~/.local/share/claude/patched/<ver>`, outside the pruned `versions/`. Keep the **2 newest**, prune the rest — roughly 545 MB.

**Verify before relying on it:** that a patched binary launches correctly from the archive path — version reporting, session start, and that the updater ignores it. If anything misbehaves, copy the archived binary back to `versions/<ver>` and launch from there instead (always write a new file and `mv` it into place; never overwrite in place, per the code-signature-per-inode caveat).

Relink the app-bundle hardlink to whatever the terminal launches so desktop and daemon launches share it, and keep the existing `pkill -f -- '--bg-spare'` so the daemon reforks from the new binary.

### Background port

Spawned detached from `check-and-apply.sh`; never blocks the launch.

- **Recursion guard**: invoke the version binary by absolute path (never the shell function) with `CLAUDE_PATCHING_AUTOPORT=1` in the environment; `check-and-apply.sh` exits immediately when that variable is set.
- **Concurrency**: a lock directory under `patches-local/`, self-healing on a stale timeout, mirroring the existing `$BIN.lock` pattern.
- **Retry policy**: on failure write `patches-local/<ver>.failed` with timestamp and reason; do not retry that version until the marker is older than 24 h or `repo` has pulled new commits. Without this, every launch respawns a failing agent.
- **Agent**: headless Opus — `<versions-binary> -p --model opus`, invoked by absolute path per the recursion guard — cwd `~/.agents/claude-patching`, sandboxed in auto permission mode (the `--permission-mode` value per `claude --help`; never `--dangerously-skip-permissions`). The sandbox and the promotion gate below bound its blast radius.

Its task: unpack the new version, apply the patch set we actually use (the `PATCH_IDS` list plus the local `.mjs` patches — not all 29 upstream patches), and re-anchor only those that fail, using the previous version's `index.json` plus phate45's `baseline-find/replace.txt` and `diff-*.json` as drift inputs. Re-anchored patches are written to **`patches-local/<ver>/`** — upstream ones as patch files there, local `.mjs` ones as `patches-local/<ver>/<name>.mjs` per the wiring rule — deliberately outside both the upstream clone (so `git pull` stays a fast-forward and never conflicts with a patch set phate45 ships later) and the canonical `$ROOT` copies (so a re-anchor for one version never rewrites the current-version patch). `apply-display-patches.sh` resolves `repo/patches/<ver>` first, then `patches-local/<ver>`, then `$ROOT` for local patches.

### Promotion gate

**The port agent never touches the live launch path.** It produces a candidate binary; promotion (archive, stamp, relink) happens only after the gate passes:

1. `node --check` on the patched bundle.
2. `<candidate> --version`, and a trivial `-p` prompt completes.
3. The full functional suite via `tests/run-all.sh <candidate>` — every applied patch's behavioral test must pass.

Mandatory vs optional: `mcp-per-subagent` **must** apply and pass its suite test — if it fails, promote nothing. A drifted *display* patch may be dropped from the set, with promotion proceeding, the dropped patch named loudly, and its suite test skipped — so one cosmetic anchor never pins the machine to an old version.

Promotion itself takes the same `$BIN.lock` that `check-and-apply.sh` uses, so a concurrent launch never reads a half-promoted state (stamp written before the binary lands, archive mid-copy). Every promoted file is written new and `mv`'d into place, per the code-signature-per-inode caveat.

### Notification

The port finishes minutes after launch, mid-session. Notify on completion via `osascript -e 'display notification …'`, and leave a message file that the next launch prints (reusing the exit-1 hold-for-Enter path). Report the version promoted and any dropped patches.

### Staleness ceiling

If the launched binary is more than 3 releases or 7 days behind the newest installed version, print a loud warning at launch. Silent indefinite fallback is this design's main risk, and Anthropic occasionally hard-deprecates old versions.

## Sequencing

1. Part A: patch and guards, verified by hand against 2.1.223 and 2.1.222.
2. The functional test suite: both harnesses, all eleven tests, proven green against a hand-patched candidate and red against stock (negative control).
3. Part B: wrapper contract, archive, background port, promotion gate invoking the suite runner.
4. Manual end-to-end: force an unpatched state, confirm the archived patched binary launches instantly, the background port runs, the gate passes, and the next launch is on the new version.

Separate commits per part.

## Out of scope

- browser-swarm changes — the single-agent cutover, the `CLAUDE_MCP_PER_AGENT` consumer check, the Firefox shared daemon, and the TS port are stage 2, which follows immediately after this stage. There is no compatibility to preserve in the meantime: this patch already changes swarm semantics (concurrent same-type agents get separate server processes and browser contexts; sequential relaunches lose warm-server reuse — cheap, since the launcher attaches to the shared daemon), and the collision-warning prose in the agent definitions goes stale until stage 2 rewrites it. Both are accepted.
- Adopting upstream `prompt-slim` (≈6.3 k standing tokens) and `system-reminders` (~100–150 tokens per event), which the current set omits. `prompt-slim` rewrites instruction text as well as trimming it, so it is a behavioral decision, not a size one.
