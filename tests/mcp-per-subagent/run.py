#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""mcp-per-subagent: two concurrent runs of one agent need two MCP servers.

    run.py <binary>

Spawns a real headless session (one of the suite's live-model
tests) that launches the same agent definition twice at once. Both
invocations declare byte-identical inline stdio `mcpServers`, which is the
condition that makes stock Claude Code hand them one shared server process and
one session.

Two invocations of *one* definition rather than two definitions on purpose: a
connection cache keyed by agent name would still collapse these two, so this is
the shape that pins per-invocation splitting.

The roles rendezvous over the log to pin the timing the test depends on.
`waiter` pings, waits for the quick probe's server to shut down, then pings
again; `quick` waits for the waiter's first ping before doing anything, so the
two are provably alive at once — sequential launches would prove nothing, since
the first server is already gone before the second connects.

A server, for every assertion here, is a process that completed the
`initialize` handshake. Claude Code also makes short-lived preflight spawns it
kills before `initialize`; those never serve anything, and counting their
startup/exit events would say nothing about how connections are shared.

Patched, the log shows two overlapping servers, each carrying the
CLAUDE_MCP_PER_AGENT canary and serving exactly one role's notes, and the
waiter's late ping lands after its sibling is gone. Stock, one server serves
both roles and dies under the waiter when the quick probe finishes — the
negative control.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
NODE = shutil.which("node") or "/opt/homebrew/bin/node"
PROMPT = (
    "Make TWO Agent tool calls, both in the SAME assistant message, as two tool_use "
    "blocks side by side, so the two subagents run at the same time. Launching them "
    "one after the other is a failure. Both must use subagent_type 'expa'. Give one "
    "the prompt 'Your role is quick.' and the other the prompt 'Your role is "
    "waiter.' Set run_in_background to false on both so you wait for them. Do not "
    "use any other tool yourself. When both subagents have returned, reply with "
    "their two final messages and nothing else."
)
ROLES = {"quick": {"quick-1"}, "waiter": {"waiter-1", "waiter-2"}}
SYSTEM_PROMPT = """You are a probe agent. Your prompt names your role: `quick` or `waiter`. Do exactly the steps for your role, in order, use no other tool, and spawn no agent. Run every Bash command exactly as written. Never skip a step because an earlier one printed something unexpected.

**quick**

1. Run this Bash command, to wait until the other probe is running: `sh {waitsh} {log} waiter-here`
2. Call `mcp__logserver__ping` once with `note` set to `quick-1`.
3. Reply with exactly: DONE quick

**waiter**

1. Call `mcp__logserver__ping` once with `note` set to `waiter-1`.
2. Run this Bash command, to wait until the other probe's server has shut down: `sh {waitsh} {log} quick-gone`
3. Call `mcp__logserver__ping` once with `note` set to `waiter-2`. If this ping fails, report the error and stop — do not retry.
4. Reply with exactly: DONE waiter"""


def agents_flag(log):
    """The `expa` definition, as --agents JSON.

    Claude Code drops inline mcpServers from an agent defined in a project
    directory unless that project is trusted; agents defined on the command line
    are exempt, so the fixture needs no trust state in the config it shares with
    the real user.
    """
    return json.dumps({"expa": {
        "description": "Probe agent. Calls the ping probe tool according to the "
                       "role in its prompt.",
        "model": "sonnet",
        "prompt": SYSTEM_PROMPT.format(waitsh=HERE / "wait-for-sibling.sh", log=log),
        "mcpServers": [{"logserver": {
            "type": "stdio",
            "command": NODE,
            "args": [str(HERE / "logsrv.js")],
            "env": {"LOGSRV_LOG": str(log)},
        }}],
    }})


def main():
    binary = sys.argv[1]
    root = pathlib.Path(tempfile.mkdtemp(prefix="cc-mcp-per-subagent-"))
    log = root / "mcp.log"

    # The nested session must not inherit this session's identity; CLAUDE_CONFIG_DIR
    # is the one CLAUDE_* variable it still needs, for authentication.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("CLAUDE") and k != "CLAUDECODE"}
    env["CLAUDE_CONFIG_DIR"] = os.environ.get(
        "CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))

    run = subprocess.run(
        [binary, "-p", "--model", "sonnet", "--permission-mode", "bypassPermissions",
         "--agents", agents_flag(log), "--output-format", "json", PROMPT],
        cwd=str(root), env=env, capture_output=True, text=True, timeout=900)

    if not log.exists():
        print(f"FAIL mcp-per-subagent: the probe server never started\n"
              f"{run.stdout[-800:]}\n{run.stderr[-800:]}")
        return 1

    events = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    handshakes = [e for e in events if e["ev"] == "init"]
    servers = {e["pid"] for e in handshakes}
    starts = {e["pid"]: e for e in events if e["ev"] == "startup" and e["pid"] in servers}
    kinds = [e["ev"] for e in events]
    notes = {}
    for event in events:
        if event["ev"] == "call":
            notes.setdefault(event["pid"], set()).add(event["note"])
    shutil.rmtree(root, ignore_errors=True)

    problems = []
    served = {pid: sorted(n) for pid, n in notes.items()}
    if len(handshakes) != 2 or len(servers) != 2:
        problems.append(f"{len(handshakes)} initialize handshake(s) across "
                        f"{len(servers)} process(es), expected 2 across 2 (served: {served})")
    for pid, start in starts.items():
        if start["claudeEnv"].get("CLAUDE_MCP_PER_AGENT") != "1":
            problems.append(f"pid {pid} did not see CLAUDE_MCP_PER_AGENT=1")
    # Both servers handshook before either goes down. Two servers that never
    # coexist prove nothing: they are what one shared connection looks like once
    # the first probe's teardown forces the second to reconnect.
    ups = [i for i, e in enumerate(events) if e["ev"] == "init"]
    downs = [i for i, e in enumerate(events)
             if e["ev"] == "exit" and e["pid"] in servers]
    if len(ups) < 2 or (downs and ups[1] > downs[0]):
        problems.append("the two servers were never up at the same time — the probes "
                        f"shared one connection, or never overlapped (log: {kinds})")
    if sorted(notes.values(), key=len) != sorted(ROLES.values(), key=len):
        problems.append(f"the two roles did not get one server each (served: {served})")
    if not any("waiter-2" in n for n in notes.values()):
        problems.append("the waiter's late ping never reached a server "
                        "— its sibling's shutdown took the connection down")

    if problems:
        print("FAIL mcp-per-subagent: " + "; ".join(problems))
        return 1
    print("pass mcp-per-subagent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
