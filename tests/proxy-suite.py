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
import signal
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from capture_proxy import CaptureProxy, system_text  # noqa: E402
from session import Scratch  # noqa: E402


def tool(body, name):
    for t in body.get("tools", []):
        if t["name"] == name:
            return t
    return None


def trim_context_bloat(binary):
    """No userEmail, currentDate, model-family blurb or env Platform/Shell line.

    The blocks do not travel together: the model-family paragraph and the
    environment block sit in the system prompt, while userEmail and currentDate
    arrive as user context in the first message. Asserting over the whole
    payload is what keeps the latter two from being vacuous — and userEmail only
    appears at all when an account is logged in, so this test's discrimination
    rests on the rest. The two env lines are matched with the newline and bullet
    that open them, escaped as the JSON-dumped payload escapes them, so no prose
    mention of a platform or a shell can pass for them.
    """
    scratch = Scratch("trim")
    with CaptureProxy() as proxy:
        scratch.run(binary, proxy, "say hi")
        payload = json.dumps(proxy.main_request())
    scratch.cleanup()
    present = [n for n in ("The user's email address is", "Today's date is",
                           "The most recent Claude models are",
                           "\\n - Platform: ", "\\n - Shell: ") if n in payload]
    assert not present, f"the request still carries: {present}"


def defer_workflow_description(binary):
    """The Workflow description is the short skill-pointer stub."""
    scratch = Scratch("defer-workflow")
    with CaptureProxy() as proxy:
        scratch.run(binary, proxy, "say hi")
        workflow = tool(proxy.main_request(), "Workflow")
    scratch.cleanup()
    assert workflow, "no Workflow tool in the request"
    description = workflow["description"]
    assert len(description) < 3000, f"Workflow description is {len(description)} chars, not a stub"
    assert 'skill: "workflow-tool"' in description, "the stub does not point at the workflow-tool skill"


def defer_artifact_description(binary):
    """The Artifact description is the short skill-pointer stub.

    The rules chunk is the bulkiest of the three the stock description
    assembles, so its marker sentence is the sharpest evidence that the chunks
    were dropped rather than merely shortened.

    Getting the tool into a headless run at all takes three nudges, because
    Claude Code gates it four ways: CLAUDE_CODE_ARTIFACT overrides the
    off-by-default-in-SDK-sessions rule, dropping
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC clears the essential-traffic
    block, and a seeded feature-flag cache — read from disk only when
    CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF says so — supplies the release
    flag. The seeded cache keeps the session hermetic: it never has to reach a
    flag service, and the test does not depend on the running user's account.
    """
    scratch = Scratch("defer-artifact")
    config = scratch.config / ".claude.json"
    seeded = json.loads(config.read_text())
    seeded["cachedGrowthBookFeatures"] = {"tengu_cobalt_plinth": True,
                                          "tengu_retire_chat_relay_artifact_backstop": True}
    config.write_text(json.dumps(seeded))
    with CaptureProxy() as proxy:
        env = scratch.env(proxy, {"CLAUDE_CODE_ARTIFACT": "1",
                                  "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": "1"})
        env.pop("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", None)
        subprocess.run([binary, "-p", "--model", "sonnet",
                        "--permission-mode", "bypassPermissions", "say hi"],
                       env=env, cwd=str(scratch.project),
                       capture_output=True, text=True, timeout=180)
        artifact = tool(proxy.main_request(), "Artifact")
    scratch.cleanup()
    assert artifact, "no Artifact tool in the request"
    description = artifact["description"]
    assert len(description) < 2500, f"Artifact description is {len(description)} chars, not a stub"
    assert 'skill: "artifact-tool"' in description, "the stub does not point at the artifact-tool skill"
    assert "**To update**: Edit the file" not in description, "the rules chunk is still inlined"


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


def hook_envelope_strip(binary):
    """A UserPromptSubmit hook's stdout reaches the model unwrapped.

    Both halves matter: the marker proves the hook ran and its output really did
    travel to the API, so the absence of the envelope is evidence about the
    framing rather than about a hook that never fired. " hook success: " is
    matched with the spaces around it, the exact text the stock template puts
    between the hook's name and its output.
    """
    marker = "HOOK_ENVELOPE_MARKER_XYZQ"
    scratch = Scratch("hook-envelope")
    scratch.write_settings(hooks={"UserPromptSubmit": [
        {"hooks": [{"type": "command", "command": f"echo {marker}"}]}]})
    with CaptureProxy() as proxy:
        scratch.run(binary, proxy, "say hi")
        payload = json.dumps(proxy.main_request())
    scratch.cleanup()
    assert marker in payload, "the hook's output never reached the request"
    assert " hook success: " not in payload, "the hook output still carries the envelope"


def task_reminder_conditional(binary):
    """The periodic task_reminder fires only when the session's task list is non-empty.

    The reminder is turn-counted, not timed: it needs ten assistant turns since
    the last task-management call, which a scripted run of trivial Reads reaches
    in seconds. Both halves matter — the empty-list half is what the patch
    changes, the non-empty half proves the run really does reach the reminder,
    so an empty-list pass cannot come from the reminder never firing at all.

    The run wears a background session's env markers (CLAUDE_CODE_SESSION_KIND=bg
    plus its paired CLAUDE_JOB_DIR), the same ones the bg daemon stamps on the
    workers it spawns. Background sessions are where the reminder machinery is
    unconditionally on, so this is the configuration the patch exists for — and
    if the non-empty half starts failing here, check whether upstream disabled
    the reminder for background sessions too, which would make the patch
    droppable rather than portable.
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
                        {"CLAUDE_CODE_TODO_REMINDER_MODE": "baseline",
                         "CLAUDE_CODE_SESSION_KIND": "bg",
                         "CLAUDE_JOB_DIR": str(scratch.root / "job")})
            seen = nag in json.dumps(proxy.requests)
        scratch.cleanup()
        return seen

    assert reminded(True), "the reminder never fired even with a task on the list"
    assert not reminded(False), "the reminder fired with an empty task list"


TESTS = {
    "trim-context-bloat": trim_context_bloat,
    "defer-workflow-description": defer_workflow_description,
    "defer-artifact-description": defer_artifact_description,
    "tool-defer-whitelist": tool_defer_whitelist,
    "hook-envelope-strip": hook_envelope_strip,
    "task-reminder-conditional": task_reminder_conditional,
}

if __name__ == "__main__":
    # run-all.sh derives its coverage from this list, so a patch loses its test
    # only by losing its entry here, never by drifting out of a second list.
    if sys.argv[1:] == ["--list"]:
        print("\n".join(TESTS))
        sys.exit(0)
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
