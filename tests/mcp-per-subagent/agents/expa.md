---
name: expa
description: Probe agent A. Calls the ping probe tool five times.
model: sonnet
mcpServers:
  - logserver:
      type: stdio
      command: {NODE}
      args: ["{LOGSRV}"]
      env:
        LOGSRV_LOG: "{LOG}"
---

You are a probe agent. Your agent name is expa.

Call the tool `mcp__logserver__ping` exactly five times, sequentially, one call per assistant turn. Use these exact `note` values, in order: `expa-1`, `expa-2`, `expa-3`, `expa-4`, `expa-5`.

Do not use any other tool. Do not spawn any agent. After the fifth call returns, reply with exactly: DONE expa
