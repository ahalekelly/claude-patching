# mcp-per-subagent fixture

A test that needs a live model: it proves each subagent invocation gets its own MCP server process, and that one invocation's shutdown does not take its sibling's connection down.

- `run.py <binary>` — the gate test. Builds a scratch project from `agents/`, drives a headless session that launches `expa` twice concurrently, and asserts on the log.
- `logsrv.js` — minimal stdio MCP server exposing one `ping` tool. Logs its PID, cwd and every `CLAUDE_*` variable at startup, its initialize handshake, every tool call, and its exit, flagged with whether it ever handshook.
- `agents/expa.md` — one agent definition declaring an inline stdio `mcpServers` entry. Two concurrent invocations therefore compute byte-identical configs, which is the condition that triggers stock's connection dedup. The prompt each invocation receives names its role: `waiter` pings, waits for the quick probe's server to shut down, then pings again; `quick` waits for the waiter's first ping before doing anything.
- `wait-for-sibling.sh` — the rendezvous both roles wait on, over the log they share. It is what makes the overlap and the teardown ordering facts rather than guesses about timing.

A server, everywhere in the assertions and the rendezvous, is a process that completed the `initialize` handshake — Claude Code also makes short-lived preflight spawns it kills before `initialize`, and those prove nothing about connection sharing. The assertions: two servers overlapping in time, `CLAUDE_MCP_PER_AGENT=1` in both startup lines, each server serving exactly one role's notes, and the waiter's late ping landing after its sibling is gone. A stock binary must fail that — one server serves both roles and dies under the waiter.

Sequential launches would prove nothing: the first server is gone before the second connects, so even stock ends up with two processes. That is why the overlap is both forced by the rendezvous and asserted from the log.

`run.py` scrubs inherited `CLAUDE_*` variables from the nested session (except `CLAUDE_CONFIG_DIR`, whose removal breaks authentication) so it does not inherit the parent's session identity.
