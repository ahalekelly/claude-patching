#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Functional tests asserting on what a candidate binary sends to the API.

    proxy-suite.py <binary> <test-id>

Each test drives one headless session against the capture proxy and asserts on
the recorded request. Exit 0 = pass. Every test must fail on a stock binary.
"""
import json
import pathlib
import re
import signal
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from capture_proxy import CaptureProxy, system_text  # noqa: E402
from session import Scratch  # noqa: E402

MARKER = "zqx-dedup-marker-7714"


def tool(body, name):
    for t in body.get("tools", []):
        if t["name"] == name:
            return t
    return None


def trim_context_bloat(binary):
    """The system prompt carries no userEmail, currentDate or model-family blurb."""
    scratch = Scratch("trim")
    with CaptureProxy() as proxy:
        scratch.run(binary, proxy, "say hi")
        system = system_text(proxy.main_request())
    scratch.cleanup()
    present = [n for n in ("The user's email address is", "Today's date is",
                           "The most recent Claude models are") if n in system]
    assert not present, f"system prompt still carries: {present}"


def defer_tool_descriptions(binary):
    """The Workflow description is the short skill-pointer stub."""
    scratch = Scratch("defer-desc")
    with CaptureProxy() as proxy:
        scratch.run(binary, proxy, "say hi")
        workflow = tool(proxy.main_request(), "Workflow")
    scratch.cleanup()
    assert workflow, "no Workflow tool in the request"
    description = workflow["description"]
    assert len(description) < 3000, f"Workflow description is {len(description)} chars, not a stub"
    assert 'skill: "workflow-tool"' in description, "the stub does not point at the workflow-tool skill"


def tool_defer_whitelist(binary):
    """A tool named in CLAUDE_CODE_IMMEDIATE_TOOLS ships its schema up front.

    MCP tools are unconditionally deferred, so the fixture server's ping tool is
    absent from the first request unless the whitelist lets it through.
    """
    scratch = Scratch("defer-whitelist")
    scratch.add_mcp_server("logserver", scratch.root / "mcp.log")
    with CaptureProxy() as proxy:
        scratch.run(binary, proxy, "say hi",
                    {"ENABLE_TOOL_SEARCH": "1",
                     "CLAUDE_CODE_IMMEDIATE_TOOLS": "mcp__logserver__ping"})
        body = proxy.main_request()
    scratch.cleanup()
    ping = tool(body, "mcp__logserver__ping")
    assert ping, ("mcp__logserver__ping was still deferred despite "
                  "CLAUDE_CODE_IMMEDIATE_TOOLS")
    assert "Logging probe" in ping["description"], "the tool shipped without its real schema"


def worktree_dedup(binary):
    """Identical rule content mirrored at two ancestor levels is injected once."""
    scratch = Scratch("dedup")
    body_text = f"# House rules\n\n{MARKER}\n"
    nested = scratch.project / "nested"
    for directory in (scratch.project, nested):
        rules = directory / ".claude" / "rules"
        rules.mkdir(parents=True)
        (rules / "house.md").write_text(body_text)
    scratch.use_subdir("nested")
    with CaptureProxy() as proxy:
        scratch.run(binary, proxy, "say hi")
        request = proxy.main_request()
    scratch.cleanup()
    blob = system_text(request) + "\n" + str(request.get("messages", ""))
    count = blob.count(MARKER)
    assert count == 1, f"duplicated CLAUDE.md content appears {count} times, expected 1"


def task_reminder_conditional(binary):
    """The periodic task_reminder fires only when the session's task list is non-empty.

    The reminder is turn-counted, not timed: it needs ten assistant turns since
    the last task-management call, which a scripted run of trivial Reads reaches
    in seconds. Both halves matter — the empty-list half is what the patch
    changes, the non-empty half proves the run really does reach the reminder,
    so an empty-list pass cannot come from the reminder never firing at all.
    """
    nag = "The task tools haven't been used recently"

    def reminded(with_task):
        scratch = Scratch("task-reminder")
        note = scratch.project / "note.txt"
        note.write_text("probe\n")
        script = []
        if with_task:
            script.append([{"tool": "TaskCreate", "id": "toolu_tc", "input": {
                "subject": "probe task", "description": "keeps the task list non-empty",
                "activeForm": "probing"}}])
        script += [[{"tool": "Read", "id": f"toolu_r{i}",
                     "input": {"file_path": str(note)}}] for i in range(14)]
        script.append([{"text": "loop finished"}])
        with CaptureProxy(script) as proxy:
            scratch.run(binary, proxy, "run the loop",
                        {"CLAUDE_CODE_TODO_REMINDER_MODE": "baseline"})
            seen = nag in json.dumps(proxy.requests)
        scratch.cleanup()
        return seen

    assert reminded(True), "the reminder never fired even with a task on the list"
    assert not reminded(False), "the reminder fired with an empty task list"


def quiet_notifications(binary):
    """A task whose output was read via TaskOutput carries no notification.

    Two background shells finish while the session is mid-turn, so both
    notifications are queued before the session acts. The session then reads
    exactly one of them with TaskOutput. The following request must carry the
    unread task's notification and not the read one — the unread half is the
    positive control that the notifications reached the request at all.
    """
    scratch = Scratch("quiet-notif")
    ids = {}

    def launch(_body):
        return [{"tool": "Bash", "id": f"toolu_{tag}", "input": {
            "command": "sleep 1; echo probe output", "description": f"probe {tag}",
            "run_in_background": True}} for tag in ("read", "unread")]

    def read_one(body):
        for message in body.get("messages", []):
            content = message.get("content")
            for block in content if isinstance(content, list) else []:
                if block.get("type") != "tool_result":
                    continue
                found = re.search(r"running in background with ID: (\S+?)\.",
                                  str(block.get("content")))
                if found:
                    ids[block["tool_use_id"]] = found.group(1)
        # Holding the answer keeps the session mid-turn long enough for both
        # shells to finish and queue their notifications before it reads one.
        time.sleep(5)
        return [{"tool": "TaskOutput", "id": "toolu_out", "input": {
            "task_id": ids.get("toolu_read", "unknown"), "block": True, "timeout": 20000}}]

    with CaptureProxy([launch, read_one, [{"text": "all done"}]]) as proxy:
        scratch.run(binary, proxy, "launch two background jobs, then read the first")
        bodies = [json.dumps(r["body"].get("messages")) for r in proxy.requests]
    scratch.cleanup()
    after_read = next((b for b in bodies if '"toolu_out"' in b), "")
    assert len(ids) == 2, f"the two background shells never both started: {ids}"
    unread = f"<task-id>{ids['toolu_unread']}</task-id>"
    read = f"<task-id>{ids['toolu_read']}</task-id>"
    assert unread in after_read, \
        "the unread task's notification never arrived — the run never reached the assertion"
    assert read not in after_read, \
        "the read task's notification was re-delivered after TaskOutput returned its output"


TESTS = {
    "trim-context-bloat": trim_context_bloat,
    "defer-tool-descriptions": defer_tool_descriptions,
    "tool-defer-whitelist": tool_defer_whitelist,
    "worktree-dedup": worktree_dedup,
    "task-reminder-conditional": task_reminder_conditional,
    "quiet-notifications": quiet_notifications,
}

if __name__ == "__main__":
    binary, test_id = sys.argv[1], sys.argv[2]
    signal.signal(signal.SIGALRM,
                  lambda *_: (_ for _ in ()).throw(AssertionError("test timed out")))
    signal.alarm(600)
    try:
        TESTS[test_id](binary)
    except AssertionError as exc:
        print(f"FAIL {test_id}: {exc}")
        sys.exit(1)
    except Exception as exc:  # a crashed session is a failed test, not a suite error
        print(f"FAIL {test_id}: {type(exc).__name__}: {exc}")
        sys.exit(1)
    print(f"pass {test_id}")
