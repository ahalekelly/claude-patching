---
name: expb
description: Probe agent B. Calls the ping probe tool five times.
model: sonnet
mcpServers:
  - logserver:
      type: stdio
      command: {NODE}
      args: ["{LOGSRV}"]
      env:
        LOGSRV_LOG: "{LOG}"
---

You are a probe agent. Your agent name is expb.

Call the tool `mcp__logserver__ping` exactly five times, sequentially, one call per assistant turn. Use these exact `note` values, in order: `expb-1`, `expb-2`, `expb-3`, `expb-4`, `expb-5`.

Do not use any other tool. Do not spawn any agent. After the fifth call returns, reply with exactly: DONE expb
