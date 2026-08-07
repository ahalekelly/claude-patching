#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""mcp-per-subagent: two concurrent subagents must get two MCP server processes.

    run.py <binary>

Spawns a real headless session (this test needs a live model, unlike the rest of
the suite) with two agent definitions whose frontmatter declares byte-identical
inline stdio mcpServers. Patched, that must produce two server PIDs of five
calls each, every one carrying CLAUDE_MCP_PER_AGENT=1. Stock, one PID serves all
ten calls and the canary is absent — the negative control.
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
    "In ONE single message, make TWO Agent tool calls at the same time so they run "
    "concurrently: one with subagent_type 'expa' and one with subagent_type 'expb'. "
    "Give each the prompt 'Do your task now.' and set run_in_background to false so "
    "you wait for both to finish. Do not use any other tool yourself. When both "
    "subagents have returned, reply with their two final messages and nothing else."
)


def build_project(root, log):
    agents = root / ".claude" / "agents"
    agents.mkdir(parents=True)
    for name in ("expa", "expb"):
        template = (HERE / "agents" / f"{name}.md").read_text()
        (agents / f"{name}.md").write_text(
            template.replace("{NODE}", NODE)
                    .replace("{LOGSRV}", str(HERE / "logsrv.js"))
                    .replace("{LOG}", str(log)))


def main():
    binary = sys.argv[1]
    root = pathlib.Path(tempfile.mkdtemp(prefix="cc-mcp-per-subagent-"))
    log = root / "mcp.log"
    build_project(root, log)

    # The nested session must not inherit this session's identity; CLAUDE_CONFIG_DIR
    # is the one CLAUDE_* variable it still needs, for authentication.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("CLAUDE") and k != "CLAUDECODE"}
    env["CLAUDE_CONFIG_DIR"] = os.environ.get(
        "CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))

    run = subprocess.run(
        [binary, "-p", "--model", "sonnet", "--permission-mode", "bypassPermissions",
         "--output-format", "json", PROMPT],
        cwd=str(root), env=env, capture_output=True, text=True, timeout=900)

    if not log.exists():
        print(f"FAIL mcp-per-subagent: the probe server never started\n{run.stdout[-800:]}\n{run.stderr[-800:]}")
        return 1

    events = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    starts = {e["pid"]: e for e in events if e["ev"] == "startup"}
    calls = {}
    for event in events:
        if event["ev"] == "call":
            calls.setdefault(event["pid"], []).append(event["note"])
    shutil.rmtree(root, ignore_errors=True)

    problems = []
    if len(starts) != 2:
        problems.append(f"{len(starts)} server process(es), expected 2 "
                        f"(calls per pid: { {p: len(c) for p, c in calls.items()} })")
    for pid, count in ((p, len(c)) for p, c in calls.items()):
        if count != 5:
            problems.append(f"pid {pid} served {count} calls, expected 5")
    for pid, start in starts.items():
        if start["claudeEnv"].get("CLAUDE_MCP_PER_AGENT") != "1":
            problems.append(f"pid {pid} did not see CLAUDE_MCP_PER_AGENT=1")
    if sum(len(c) for c in calls.values()) != 10:
        problems.append(f"{sum(len(c) for c in calls.values())} calls in total, expected 10")

    if problems:
        print("FAIL mcp-per-subagent: " + "; ".join(problems))
        return 1
    print("pass mcp-per-subagent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
