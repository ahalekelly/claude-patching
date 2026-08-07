#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Functional tests asserting on what a candidate binary sends to the API.

    proxy-suite.py <binary> <test-id>

Each test drives one headless session against the capture proxy and asserts on
the recorded request. Exit 0 = pass. Every test must fail on a stock binary.
"""
import pathlib
import signal
import sys

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


TESTS = {
    "trim-context-bloat": trim_context_bloat,
    "defer-tool-descriptions": defer_tool_descriptions,
    "tool-defer-whitelist": tool_defer_whitelist,
    "worktree-dedup": worktree_dedup,
}

if __name__ == "__main__":
    binary, test_id = sys.argv[1], sys.argv[2]
    signal.signal(signal.SIGALRM,
                  lambda *_: (_ for _ in ()).throw(AssertionError("test timed out")))
    signal.alarm(300)
    try:
        TESTS[test_id](binary)
    except AssertionError as exc:
        print(f"FAIL {test_id}: {exc}")
        sys.exit(1)
    except Exception as exc:  # a crashed session is a failed test, not a suite error
        print(f"FAIL {test_id}: {type(exc).__name__}: {exc}")
        sys.exit(1)
    print(f"pass {test_id}")
