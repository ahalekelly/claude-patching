# Porting claude-patching to Claude Code mods — assessment (2026-09-19)

## What a mod is

A mod is a plugin whose `hooks/hooks.json` names one TypeScript module exporting `register(on, options)`. Each hook is `on(event, matcher?, ($, e, next) => result)`: `$` is the engine interface (session, prompt, tool, ui, fs, process, store, clock, http, env, config), `e` the frozen event input, and `next(e)` the rest of the chain down to the engine's own behaviour. Returning without `next` answers in place of the engine; `next({ ...e, x })` rewrites what the chain beneath sees. Hooks nest by tier: managed prepend → user-installed → managed append → bundled → engine. The module runs in a sandboxed worker with no Node and no DOM.

The runtime is already in the binary we run: 2.1.270 contains the hooks worker, the `plugin-authoring` skill and `/plugin-types` (which writes the exact `claude-code.d.ts` for the running build). It is gated by `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (otherwise a GrowthBook flag, `tengu_plugin_hooks_modules`, default off). Anthropic committed on 2026-09-09 to shipping it "on the scale of weeks". The API is early access and may change between releases, but drift shows up as type errors and `claude plugin validate` failures rather than silently missing minified anchors.

Two properties decide most of what follows:

- **Display hooks only touch the terminal renderer.** `ui.render` draws the CLI's components (`ToolUse`, `ToolGroup`, `UserMessage`, `Spinner`, `Pane`, …). T3 Code renders its own UI from the SDK stream, so a display mod does nothing for our sessions, the same reason the display patches were retired.
- **There are no hooks on MCP server lifecycle, keybindings, thinking blocks, or the agents view.** The MCP surface is `$.mcp.call` only; `AgentInfo` has no model field; `RenderComponent` has no thinking or agent-list component.

Loading: `claude --plugin-dir <dir>` for development (the folder is watched and hot-reloads). For every session, including T3's, install it as a plugin from a local marketplace and enable it in settings; options come from `userConfig` in `plugin.json`, stored under `pluginConfigs` and shown as `/config` rows. The env var goes in `claude-launch`.

## Current patches

| Patch | Mod route | Verdict |
| --- | --- | --- |
| `tool-defer-whitelist` | `on("tool.describe", { tool }, ...)` → `{ ...e, isDeferred: false }`. This is literally the d.ts example (`on("tool.describe", { tool: "Monitor" }, pin)`). The tool list becomes a `userConfig` field instead of `CLAUDE_CODE_IMMEDIATE_TOOLS`. | **Port** |
| `trim-context-bloat` | `prompt.section`: return `{ text: null }` for a section, or regex-rewrite its text (drop `Platform:`/`Shell:` lines from the env section). Sections are keyed by engine names like `env_info_simple`; log `e.name` once with a `*` matcher to find the four we touch. Answers are cached per session, so it costs nothing on the prompt cache. | **Port** |
| `hook-envelope-strip` | `prompt.attachment` with `{ origin: { kind: "hook" } }` and strip `^\S+ hook success: `. The engine builds that prefix when it renders the attachment; the d.ts says only the `<system-reminder>` wrapper sits outside what the chain sees, so the prefix should be in `e.text`. Verify on first build. Better: move our own `UserPromptSubmit` hooks (`usage-context.sh`, `usage-identity.py`, `todo-capture.sh`) into the mod as `prompt.submit` `context` entries, and the envelope never exists. | **Port** (verify) |
| `task-reminder-conditional` | `on("prompt.attachment", { type: "todo_reminder" }, ...)` → `{ text: null }` when the task list is empty. Attachment answers are held for the process, so call `$.ui.invalidate("prompt.attachment")` when task state changes; track it by observing `tool.call` on the task tools or reading the task file via `$.fs`. | **Port** |
| `cron-visibility` | `prompt.submit` with `{ origin: { kind: "scheduled-trigger" } }` → `next({ ...e, text: "CronJob: " + e.text })`; "the user message on screen follows" the rewrite, so it renders too. `session.receive` has the same origin for the queued path. | **Port** |
| `task-notification-provenance` | `session.receive` `{ origin: { kind: "task-notification" } }` exposes `event.data`, but nothing in the types says it carries what started the run. A mod can reconstruct most of it itself: record `agent.spawn` (launch) and `tool.call { tool: "SendMessage" }` per agent id, then annotate the notification text. Auto-resume is not observable. | **Partial** |
| `mcp-per-subagent` | No MCP lifecycle hooks; `AgentSpec.mcpServers` only names servers. | **Stays a binary patch** |
| `agents-view-models` | The agents view is not a render component and `AgentInfo` has no model. `agent.spawn` does reveal the resolved model, so a mod could show it via `$.ui.status` or the `AbovePrompt` band, but not in the view itself. Terminal-only anyway. | **Not portable** |
| `toolsearch-visibility` *(default-off)* | `ui.render { component: "ToolUse", props: { tool: "ToolSearch" } }` could draw the query, if the engine raises a render for rows it currently hides (unknown). Terminal-only. | **Maybe; not worth it** |
| `thinking-latest` *(default-off)* | No thinking component in `RenderComponent`. | **Not portable** |

## Retired patches

| Patch | Why retired | Mod route | Verdict |
| --- | --- | --- | --- |
| `no-collapse-tool-calls` | React Compiler output made the anchor unrepairable | `on("ui.render", { component: "ToolGroup" }, ($, e, next) => next({ ...e, props: { ...e.props, isExpanded: true } }))`. Exactly the case mods were built for; terminal-only. | **Portable**, terminal only |
| `communicating-with-user`, `ant-faithful-outcomes` | Removed | `prompt.section` by name: return the full text for models the engine gives the clipped variant, or append the outcome rules to their section. The prose becomes a string we maintain in the mod. | **Portable** |
| `defer-workflow-description`, `defer-artifact-description` | Upstream deferred Workflow; Artifact is off by setting | `tool.describe` → shorter `description` plus `isDeferred: true`. Moot for these two, but `isDeferred: true` is a general "push this tool behind ToolSearch" knob: a second list in the same mod as the pin list. | **Portable**, moot |
| `quiet-notifications` | Upstream fixed the duplicate | `session.receive` → `{ consumed: reason }` for a duplicate notification. | **Portable**, moot |
| `worktree-dedup` | Retired by choice with the above; anchor defect noted upstream | `prompt.context` → dedupe `instructionFiles` by path before `next`. | **Portable** if the duplication still happens |
| `agent-list-models` | React Compiler | No agent-list component. | **Not portable** |
| `agents-view-shortcut`, `new-session-shortcut` | React Compiler | No keybinding hooks (`prompt.edit` only sees edits inside the prompt box). | **Not portable** |
| `thinking-visibility`, `thinking-no-fold` | Anchors drifted | No thinking component. | **Not portable** |
| `sticky-prompt-header` | Moot under T3 | No header component. | **Not portable**, moot |

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
