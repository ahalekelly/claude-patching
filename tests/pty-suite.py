#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyte"]
# ///
"""Functional tests asserting on what a candidate binary draws.

    pty-suite.py <binary> <test-id>

Each test drives the interactive TUI in a pseudo-terminal, answers the session
from the capture proxy so it costs no tokens, and asserts on the rendered rows.
Exit 0 = pass. Every test must fail on a stock binary.
"""
import fcntl
import os
import pathlib
import pty
import select
import signal
import struct
import sys
import termios
import time

import pyte

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from capture_proxy import CaptureProxy  # noqa: E402
from session import Scratch  # noqa: E402

COLS, ROWS = 110, 34
PROMPT_MARKER = "quixotic-prompt-marker"


class Term:
    """The candidate running under a pty, rendered into a pyte screen."""

    def __init__(self, argv, env, cwd):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(cwd)
                os.environ.clear()
                os.environ.update(env)
                os.execv(argv[0], argv)
            finally:
                os._exit(127)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    def pump(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if not ready:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if not data:
                return
            self.stream.feed(data)

    def rows(self):
        return [row.rstrip() for row in self.screen.display]

    def text(self):
        return "\n".join(self.rows())

    def wait_for(self, needle, timeout=90):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump(0.5)
            if needle in self.text():
                return True
        print(f"[pty] timed out waiting for {needle!r}", file=sys.stderr)
        return False

    def send(self, keys):
        os.write(self.fd, keys.encode())

    def submit(self, line):
        self.send(line)
        time.sleep(0.4)
        self.send("\r")

    def close(self):
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, os.WNOHANG)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def start(binary, scratch, proxy, extra_env=None):
    env = scratch.env(proxy, extra_env)
    env.update({"TERM": "xterm-256color", "COLUMNS": str(COLS), "LINES": str(ROWS),
                "FORCE_COLOR": "0", "NO_COLOR": "1"})
    term = Term([binary, "--permission-mode", "bypassPermissions", "--model", "sonnet"],
                env, str(scratch.project))
    if not term.wait_for("bypass permissions on", timeout=90):
        term.close()
        raise AssertionError("the TUI never reached its input prompt")
    return term


def read_blocks(paths):
    return [{"tool": "Read", "id": f"toolu_read{i}", "input": {"file_path": str(p)}}
            for i, p in enumerate(paths)]


def no_collapse_reads(binary):
    """Parallel Read calls render as individual lines, not a "Read N files" roll-up."""
    scratch = Scratch("no-collapse")
    paths = []
    for name in ("alpha.txt", "beta.txt", "gamma.txt"):
        path = scratch.project / name
        path.write_text(f"contents of {name}\n")
        paths.append(path)
    with CaptureProxy([read_blocks(paths), [{"text": "all read"}]]) as proxy:
        term = start(binary, scratch, proxy)
        term.submit("read the three files")
        term.wait_for("all read", timeout=90)
        screen = term.text()
        term.close()
    scratch.cleanup()
    assert "files" not in screen.split("alpha.txt")[0][-200:], \
        f"reads were collapsed into a roll-up:\n{screen}"
    named = sum(1 for name in ("alpha.txt", "beta.txt", "gamma.txt") if name in screen)
    assert named == 3, f"only {named}/3 reads rendered individually:\n{screen}"


def toolsearch_visibility(binary):
    """A ToolSearch call renders a visible line."""
    scratch = Scratch("toolsearch")
    scratch.add_mcp_server("logserver", scratch.root / "mcp.log")
    script = [[{"tool": "ToolSearch", "id": "toolu_ts", "input": {"query": "select:mcp__logserver__ping"}}],
              [{"text": "search done"}]]
    with CaptureProxy(script) as proxy:
        term = start(binary, scratch, proxy, {"ENABLE_TOOL_SEARCH": "1"})
        term.submit("find the ping tool")
        term.wait_for("search done", timeout=90)
        screen = term.text()
        term.close()
    scratch.cleanup()
    assert "ToolSearch" in screen, f"the ToolSearch call was not rendered:\n{screen}"


def sticky_prompt_header(binary):
    """With the prompt scrolled off-screen, the previous-prompt header still renders."""
    scratch = Scratch("sticky")
    # A long answer scrolls the prompt off the top while it stays the session's
    # most recent prompt, which is exactly the state the header exists for.
    long_answer = "\n".join(f"answer line {i}" for i in range(1, 301))
    with CaptureProxy([[{"text": long_answer}]]) as proxy:
        term = start(binary, scratch, proxy)
        term.submit(f"{PROMPT_MARKER} please answer at length")
        term.wait_for("answer line 300", timeout=90)
        term.pump(4)
        screen = term.text()
        term.close()
    scratch.cleanup()
    assert "answer line 300" in screen, f"the answer never rendered:\n{screen}"
    header = "\n".join(screen.split("\n")[:2])
    assert PROMPT_MARKER in header, \
        f"the scrolled-off prompt is not in the header rows {header!r}:\n{screen}"


TESTS = {
    "no-collapse-reads": no_collapse_reads,
    "toolsearch-visibility": toolsearch_visibility,
    "sticky-prompt-header": sticky_prompt_header,
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
    except Exception as exc:
        print(f"FAIL {test_id}: {type(exc).__name__}: {exc}")
        sys.exit(1)
    print(f"pass {test_id}")
