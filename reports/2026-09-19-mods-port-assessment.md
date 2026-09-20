# Porting claude-patching to Claude Code mods — assessment (2026-09-19)

## What a mod is

A mod is a plugin whose `hooks/hooks.json` names one TypeScript module exporting `register(on, options)`. Each hook is `on(event, matcher?, ($, e, next) => result)`: `$` is the engine interface (session, prompt, tool, ui, fs, process, store, clock, http, env, config), `e` the frozen event input, and `next(e)` the rest of the chain down to the engine's own behaviour. Returning without `next` answers in place of the engine; `next({ ...e, x })` rewrites what the chain beneath sees. Hooks nest by tier: managed prepend → user-installed → managed append → bundled → engine. The module runs in a sandboxed worker with no Node and no DOM.

The runtime is already in the binary we run: 2.1.270 contains the hooks worker, the `plugin-authoring` skill and `/plugin-types` (which writes the exact `claude-code.d.ts` for the running build). It is gated by `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (otherwise a GrowthBook flag, `tengu_plugin_hooks_modules`, default off). Anthropic committed on 2026-09-09 to shipping it "on the scale of weeks". The API is early access and may change between releases, but drift shows up as type errors and `claude plugin validate` failures rather than silently missing minified anchors.

Two properties decide most of what follows:

- **Display hooks only touch the terminal renderer.** `ui.render` draws the CLI's components (`ToolUse`, `ToolGroup`, `UserMessage`, `Spinner`, `Pane`, …). T3 Code renders its own UI from the SDK stream, so a display mod does nothing for our sessions, the same reason the display patches were retired.
- **There are no hooks on MCP server lifecycle, keybindings, thinking blocks, or the agents view.** The MCP surface is `$.mcp.call` only; `AgentInfo` has no model field; `RenderComponent` has no thinking or agent-list component.

Loading: `claude --plugin-dir <dir>` for development (the folder is watched and hot-reloads). For every session, including T3's, install it as a plugin from a local marketplace and enable it in settings; options come from `userConfig` in `plugin.json`, stored under `pluginConfigs` and shown as `/config` rows. The env var goes in `claude-launch`.

## Current patches

### Port

**`tool-defer-whitelist`** — Claude Code defers most tool schemas behind ToolSearch to save prompt tokens; the model must search before it can call them. This patch ships the full schema up front for the tools named in `CLAUDE_CODE_IMMEDIATE_TOOLS` (we pin WebFetch and WebSearch), so the model calls them in one step.
Mod: `on("tool.describe", { tool }, ...)` returning `{ ...e, isDeferred: false }`. This is literally the d.ts example (`on("tool.describe", { tool: "Monitor" }, pin)`). The tool list becomes a `userConfig` field editable in `/config` instead of an env var.

**`trim-context-bloat`** — Drops standing system-prompt text that spends tokens every call and helps nothing: the `userEmail` and `currentDate` lines, the paragraph describing the model family, and the env block's `Platform:` and `Shell:` lines.
Mod: `prompt.section`, which fires once per named section (`env_info_simple`, `memory`, …). Return `{ text: null }` to drop a section, or regex-rewrite its text to drop lines inside it. Answers are cached per session, so the prompt cache is unaffected. Log `e.name` once with a `*` matcher to find the sections holding our four targets.

**`hook-envelope-strip`** — When a SessionStart, UserPromptSubmit or UserPromptExpansion hook prints to stdout, the engine hands the model `<name> hook success: <output>`. Our hooks inject context (usage lines, identity, captured todos) that reads better as itself, so this patch removes the wrapper.
Mod: `prompt.attachment` with matcher `{ origin: { kind: "hook" } }`, stripping `^\S+ hook success: ` from `e.text`. The engine builds that prefix when it renders the attachment; the d.ts says only the `<system-reminder>` wrapper sits outside what the chain sees, so the prefix should be in `e.text`. Verify on first build. Better still: move our own `UserPromptSubmit` hooks (`usage-context.sh`, `usage-identity.py`, `todo-capture.sh`) into the mod as `prompt.submit` `context` entries, and the envelope never exists.

**`task-reminder-conditional`** — The engine periodically injects a "task tools haven't been used recently" reminder. In sessions with no task list it is pure noise, so this patch fires it only when the session's task list is non-empty.
Mod: `on("prompt.attachment", { type: "todo_reminder" }, ...)` returning `{ text: null }` when the list is empty. Attachment answers are held for the process, so call `$.ui.invalidate("prompt.attachment")` when task state changes; track it by observing `tool.call` on the task tools or reading the task file via `$.fs`.

**`cron-visibility`** — A cron-fired prompt arrives as an anonymous user turn and is hidden from the transcript. This patch renders it and prefixes what the model sees with `CronJob:`, so the model and the reader can tell it from a typed message.
Mod: `prompt.submit` with `{ origin: { kind: "scheduled-trigger" } }`, returning `next({ ...e, text: "CronJob: " + e.text })`. The docstring says "the user message on screen follows" the rewrite, so it renders too. `session.receive` carries the same origin for the queued path.

### Partial

**`task-notification-provenance`** — When a background agent finishes, its notification gains a `<trigger>` element saying what started that run: the original launch, a user message sent to the agent, a SendMessage from another agent, or an auto-resume. The owner can then tell a user-initiated continuation from a rogue one ([#84957](https://github.com/anthropics/claude-code/issues/84957)).
Mod: `session.receive` with `{ origin: { kind: "task-notification" } }` exposes `event.data`, but nothing in the types says it carries the trigger. A mod can reconstruct most of it: record `agent.spawn` (launch) and `tool.call { tool: "SendMessage" }` per agent id, then annotate the notification text. Auto-resume is not observable.

### Stays a binary patch

**`mcp-per-subagent`** — Stock shares one process per stdio MCP server between every concurrent subagent that declares it, so parallel subagents collide on stateful servers such as browser sessions ([#84638](https://github.com/anthropics/claude-code/issues/84638)). This patch gives each subagent its own process for the servers its frontmatter declares inline. It is the one patch marked mandatory.
Mod: no MCP lifecycle hooks exist; `AgentSpec.mcpServers` only names servers.

### Not portable

**`agents-view-models`** — Job rows in the agents view show their `--model` flag in the age column ("fable · 3m"), so a silently inherited model is visible.
Mod: the agents view is not a render component and `AgentInfo` has no model field. `agent.spawn` does reveal the resolved model, so a mod could show it in `$.ui.status` or the `AbovePrompt` band, not in the view. Terminal-only anyway.

**`toolsearch-visibility`** *(default-off)* — ToolSearch calls render with their query instead of being absorbed silently.
Mod: `ui.render { component: "ToolUse", props: { tool: "ToolSearch" } }` could draw the query, if the engine raises a render for rows it currently hides (unknown). Terminal-only; not worth testing.

**`thinking-latest`** *(default-off)* — The "Thought for Ns" pill keeps a one-line, hover-highlightable summary of the group's most recent thinking block after the turn completes; clicking still opens every block.
Mod: no thinking component in `RenderComponent`.

## Retired patches

### Portable now

**`no-collapse-tool-calls`** — Read, Grep, Glob and Bash calls render individually instead of collapsing into "Read 3 files" or "ran 4 shell commands"; ctrl+f toggled stock folding back on. Retired when 2.1.260's React Compiler output made the anchor unrepairable.
Mod: `on("ui.render", { component: "ToolGroup" }, ($, e, next) => next({ ...e, props: { ...e.props, isExpanded: true } }))`. Exactly the case mods were built for. Terminal-only.

**`communicating-with-user`** — Every model gets the full "# Communicating with the user" prompt section; stock reserves it for a few model families and hands everything else a clipped bulleted variant.
**`ant-faithful-outcomes`** — The outcome-reporting rules (never claim tests pass over failing output, don't hedge confirmed results) reach every session; stock builds them only into the simple system prompt.
Mod for both: `prompt.section` by name, returning the full text where the engine gives the clipped variant, or appending the outcome rules to their section. The prose becomes a string we maintain in the mod.

**`worktree-dedup`** — Prevented the same CLAUDE.md being injected twice when a session ran inside a nested worktree. Retired by choice; the upstream anchor defect is in phate45/claude-patching#3.
Mod: `prompt.context`, dedupe `instructionFiles` by path before `next`. Worth it only if the duplication still happens.

**`defer-workflow-description`**, **`defer-artifact-description`** — Replaced the Workflow tool's ~5k-token and the Artifact tool's ~1.5k-token descriptions with stubs pointing at skills holding the full text. Retired because upstream now defers Workflow itself and `"enableArtifact": false` removes Artifact.
Mod: `tool.describe` with a shorter `description` plus `isDeferred: true`. Moot for these two, but `isDeferred: true` is a general "push this tool behind ToolSearch" knob, a second list beside the pin list in the same mod.

**`quiet-notifications`** — Suppressed duplicate background-task notifications. Retired because the binary now claims the notified flag at enqueue, and the patch's read-marker swallowed a resumed agent's next genuine report.
Mod: `session.receive` returning `{ consumed: reason }` for a duplicate. Moot.

### Not portable

**`agent-list-models`** — The in-session agent list showed each row's resolved model ("11m 50s · fable · ↓ 92.8k tokens"), so silently inherited spawns were visible. Retired with the React Compiler change.
Mod: no agent-list component.

**`agents-view-shortcut`** — A rebindable keybinding opened the agents view from anywhere; stock offers only left-arrow on an empty idle prompt.
**`new-session-shortcut`** — ctrl+n spawned a fresh session and attached to it, from FleetView or from inside a session.
Mod: no keybinding hooks; `prompt.edit` only sees edits inside the prompt box.

**`thinking-visibility`** — Thinking blocks rendered inline in the normal chat view, expanded; stock shows them only in transcript mode or under `--verbose`.
**`thinking-no-fold`** — A thinking block stayed its own transcript entry instead of folding into the adjacent collapsed read/search group's "Thought for Ns" pill.
Mod: no thinking component.

**`sticky-prompt-header`** — The previous-prompt header above the transcript showed whenever the prompt had scrolled off the top, in readable contrast. Retired as moot under T3.
Mod: no header component.

## Other features that could become mods

- **Our `UserPromptSubmit` shell hooks** (`usage-context.sh`, `usage-identity.py`, `todo-capture.sh`) could run as `prompt.submit` hooks attaching `context`, which removes the `hook success:` envelope at the source and one Python/uv spawn per prompt. `prevent-rm.py` and `allow-mcp.py` map to `tool.call` with `{ deny }`, but they work fine as classic hooks and gain nothing. `tab-title.py` is terminal-only; leave it.
- **`CLAUDE_CODE_IMMEDIATE_TOOLS`** becomes a `userConfig` list, editable in `/config`.

## Recommendation

Build one mod under `~/.agents/claude/mods/` that ports the five prompt-side patches (`tool-defer-whitelist`, `trim-context-bloat`, `hook-envelope-strip`, `task-reminder-conditional`, `cron-visibility`) plus the `communicating-with-user`/`ant-faithful-outcomes` sections if we still want them. That leaves claude-patching holding `mcp-per-subagent` and, optionally, `task-notification-provenance`: the porter's job shrinks from ten anchors to one or two, and the retired-display-patch problem goes away because those never mattered under T3.

Things to settle in the first build:

1. Confirm `e.text` for a hook-origin `prompt.attachment` includes the `hook success:` prefix, and that `todo_reminder` is the task reminder we gate.
2. Log `prompt.section` names once to find the four sections `trim-context-bloat` edits.
3. Failure semantics are the opposite of claude-patching's: a hook that throws or returns a wrong shape is *skipped* and the engine's default runs, reported once in a dim transcript line and in `--debug`. Add `claude plugin test` cases and a smoke check in `tests/run-all.sh` so a silently-skipped hook fails the suite rather than the session.
4. Regenerate types with `/plugin-types` on each upgrade instead of trusting the checked-in `mods/types/claude-code.d.ts` (that copy is from 2.1.277; we run 2.1.270).

Sources: anthropics/claude-code `mods/` (README, `types/claude-code.d.ts`, the four bundled mods), the `plugin-authoring` skill embedded in the 2.1.270 binary, [issue #91870](https://github.com/anthropics/claude-code/issues/91870), and the claude-patching git history for retirement reasons.
