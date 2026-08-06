# mcp-per-subagent fixture

Raw material for the promotion-gate test that proves each subagent gets its own MCP server process. Not yet a runnable test — it captures the reproduction, not the assertions.

- `logsrv.js` — minimal stdio MCP server exposing one `ping` tool. Logs its PID, cwd, and every `CLAUDE_*` variable at startup, then every JSON-RPC line it receives. The PID lines are what distinguish one shared server from one server per subagent.
- `agents/expa.md`, `agents/expb.md` — two agent definitions, identical apart from `name`, both declaring the same inline stdio `mcpServers` entry. Byte-identical configs are the condition that triggers the dedup.
- `run.sh` — drives a headless session that spawns both agents concurrently in a single message.

To turn this into the gate test:

- Parameterize the paths. `run.sh` hardcodes a project directory and the `claude` binary; both must become arguments so the test can run a *candidate* binary against a scratch project built from `agents/`. The scratch project needs the two definitions in its `.claude/agents/`.
- Add the assertions. On a patched binary the log must show **two** startup PIDs, each serving five calls, and each startup line must carry `CLAUDE_MCP_PER_AGENT=1`. On a stock binary it shows one PID serving ten calls — worth keeping as the negative control.
- Keep the environment scrub. `run.sh` unsets inherited `CLAUDE_*` variables (except `CLAUDE_CONFIG_DIR`, whose removal breaks authentication) so the nested session does not inherit the parent's session identity.
