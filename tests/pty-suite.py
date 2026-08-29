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
import hashlib
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time

import pyte

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from capture_proxy import CaptureProxy  # noqa: E402
from session import Scratch  # noqa: E402

COLS, ROWS = 110, 34
PROMPT_MARKER = "quixotic-prompt-marker"


class Screen(pyte.Screen):
    """pyte.Screen that tolerates DECDSR (`CSI ? 6 n`): Claude Code emits the
    private-mode cursor-position query in its no-flicker fullscreen path, and
    pyte's report_device_status() takes no `private` kwarg and would crash the
    harness. The query needs no answer — the tests never feed replies back."""

    def report_device_status(self, mode, private=False):
        if not private:
            super().report_device_status(mode)


class Term:
    """The candidate running under a pty, rendered into a pyte screen."""

    def __init__(self, argv, env, cwd):
        self.screen = Screen(COLS, ROWS)
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


def no_collapse_tool_calls(binary):
    """Tool calls render individually, and ctrl+f toggles stock folding back.

    Stock collapses parallel Reads into "Read N files" and — in the tui — Bash
    calls into "ran N shell commands"; patched, each call is its own line.
    The default ctrl+f binding folds the already-rendered turn into the stock
    roll-up, and a second press unfolds it again.
    """
    scratch = Scratch("no-collapse")
    paths = []
    for name in ("alpha.txt", "beta.txt", "gamma.txt"):
        path = scratch.project / name
        path.write_text(f"contents of {name}\n")
        paths.append(path)
    bash = {"tool": "Bash", "id": "toolu_bash0",
            "input": {"command": "echo quokka-bash-probe"}}
    with CaptureProxy([read_blocks(paths) + [bash], [{"text": "all read"}]]) as proxy:
        term = start(binary, scratch, proxy)
        term.submit("read them")
        term.wait_for("all read", timeout=90)
        screen = term.text()
        term.send("\x06")  # ctrl+f: fold
        term.pump(2)
        folded = term.text()
        term.send("\x06")  # ctrl+f: unfold
        term.pump(2)
        unfolded = term.text()
        term.close()
    scratch.cleanup()
    assert not re.search(r"Read \d+ files", screen), \
        f"reads were collapsed into a roll-up:\n{screen}"
    named = sum(1 for name in ("alpha.txt", "beta.txt", "gamma.txt") if name in screen)
    assert named == 3, f"only {named}/3 reads rendered individually:\n{screen}"
    assert "shell command" not in screen, \
        f"the shell command was collapsed into a roll-up:\n{screen}"
    assert "quokka-bash-probe" in screen, \
        f"the shell command did not render individually:\n{screen}"
    assert re.search(r"Read \d+ files", folded), \
        f"ctrl+f did not fold the rendered turn into a roll-up:\n{folded}"
    assert re.search(r"Read \d+ files", unfolded) is None, \
        f"a second ctrl+f did not unfold the roll-up:\n{unfolded}"
    named = sum(1 for name in ("alpha.txt", "beta.txt", "gamma.txt") if name in unfolded)
    assert named == 3, \
        f"only {named}/3 reads rendered individually after unfolding:\n{unfolded}"


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


def cron_visibility(binary):
    """A cron-fired prompt renders in the transcript and reaches the model prefixed.

    A durable one-minute task whose creation time is already minutes old is due
    the moment the scheduler's first tick runs, so the fire needs no waiting.
    The task id's leading hex digits seed the fire jitter — all-zero means none.
    Stock hides the fired prompt entirely (it is a meta message) and sends it to
    the model unmarked; patched shows it and prefixes both copies.
    """
    scratch = Scratch("cron")
    payload = "zqx-cron-fired-prompt"
    claude_dir = scratch.project / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "scheduled_tasks.json").write_text(json.dumps({"tasks": [{
        "id": "00000000-cron-visibility", "cron": "* * * * *", "prompt": payload,
        "createdAt": int(time.time() * 1000) - 180_000, "recurring": True,
    }]}))
    with CaptureProxy([[{"text": "cron answered"}]]) as proxy:
        term = start(binary, scratch, proxy)
        fired = term.wait_for("cron answered", timeout=90)
        term.pump(3)
        screen = term.text()
        requests = json.dumps(proxy.requests)
        term.close()
    scratch.cleanup()
    assert fired, f"the scheduled task never fired:\n{screen}"
    assert payload in requests, "the fired prompt never reached the model"
    # Rendering is asserted before the prefix on purpose: it is the assertion a
    # stock binary fails on its own behavior rather than on a string this patch
    # invented, so it is what a stock failure reason should name.
    assert payload in screen, \
        f"the cron-fired prompt was not rendered in the transcript:\n{screen}"
    assert f"CronJob: {payload}" in screen, \
        f"the rendered prompt carries no CronJob prefix:\n{screen}"
    assert f"CronJob: {payload}" in requests, \
        "the prompt reached the model without the CronJob prefix"


def agents_view_shortcut(binary):
    """ctrl+a opens the agents view from a normal idle session.

    \\x01 is how a terminal sends ctrl+a. Stock only moves the input cursor
    home, so the screen must be unchanged there; patched backgrounds the
    conversation and switches to the agents view.
    """
    scratch = Scratch("agents-view")
    with CaptureProxy() as proxy:
        term = start(binary, scratch, proxy)
        term.pump(2)
        before = term.text()
        term.send("\x01")
        term.pump(6)
        after = term.text()
        term.close()
        _reap_scratch_daemon(scratch)
    scratch.cleanup()
    assert "moved to the background" in after and "Needs input" in after, \
        f"ctrl+a did not open the agents view:\n{after}"
    assert before != after, "ctrl+a left the screen untouched"


def _reap_scratch_daemon(scratch):
    """Kill the transient daemon tree the test's session spawns left behind.

    `claude agents` and the new-session spawn flow hand sessions to a
    transient daemon whose process tree — daemon, bg-spare warm pool, pty
    hosts, the spawned sessions themselves — outlives the pty child, so the
    test would leak live processes without this. Every kill pattern is pinned
    to this scratch: its daemon runtime dir cc-daemon-<uid>/<hash>, where
    <hash> is sha256 of the scratch's CLAUDE_CONFIG_DIR (matching the
    bg-spare and pty-host argvs), the session ids its job state recorded
    (matching the session processes), and the scratch root itself (matching
    the daemon's --spawned-by argv). Nothing broad enough to reach the
    user's own daemons.
    """
    uid = os.getuid()
    roots = {str(scratch.root), os.path.realpath(scratch.root)}
    daemon_dirs = {}
    for cfg in {str(scratch.config), os.path.realpath(scratch.config)}:
        digest = hashlib.sha256(cfg.encode()).hexdigest()[:8]
        daemon_dirs[digest] = pathlib.Path(f"/tmp/cc-daemon-{uid}/{digest}")
    # The handoff is asynchronous — a session backgrounded just before the
    # pty died may still be respawning under the daemon during the first kill
    # round — so sweep repeatedly, re-reading the daemon dir each round (it
    # names a socket per session it hosts, and the bare session processes
    # carry nothing else a kill pattern could target), until a round finds
    # nothing alive.
    for _ in range(5):
        patterns = set(roots)
        for digest, daemon_dir in daemon_dirs.items():
            patterns.add(f"cc-daemon-{uid}/{digest}")
            for sub in ("pty", "rv"):
                for sock in (daemon_dir / sub).glob("*.sock"):
                    short = sock.name.split(".")[0]
                    if re.fullmatch(r"[0-9a-f]{8}", short):
                        # No leading dashes: pkill parses them as options.
                        patterns.add(f"session-id {short}")
        killed = [pattern for pattern in patterns
                  if subprocess.run(["pkill", "-9", "-f", pattern],
                                    capture_output=True).returncode == 0]
        if not killed:
            break
        time.sleep(1)
    for daemon_dir in daemon_dirs.values():
        shutil.rmtree(daemon_dir, ignore_errors=True)


def new_session_shortcut(binary):
    """ctrl+n spawns and attaches a fresh session, from FleetView and in-session.

    \\x0e is how a terminal sends ctrl+n. In `claude agents`, stock moves the
    list selection; patched runs the new-session spawn flow and the screen
    becomes an attached fresh session, whose footer hint "← for agents" is a
    string FleetView itself never draws. From an idle session, stock does
    nothing; patched backgrounds the conversation into the agents view, whose
    next render consumes the handoff stamp and auto-spawns — the attached
    fresh session draws "manual mode on" where the origin session showed the
    bypassPermissions banner.
    """
    scratch = Scratch("new-session")
    with CaptureProxy() as proxy:
        env = scratch.env(proxy)
        env.update({"TERM": "xterm-256color", "COLUMNS": str(COLS),
                    "LINES": str(ROWS), "FORCE_COLOR": "0", "NO_COLOR": "1"})
        term = Term([binary, "agents"], env, str(scratch.project))
        opened = term.wait_for("describe a task for a new session", timeout=90)
        if opened:
            term.send("\x0e")
            attached = term.wait_for("← for agents", timeout=60)
            screen = term.text()
        term.close()
        _reap_scratch_daemon(scratch)
    scratch.cleanup()
    assert opened, "the agents view never rendered"
    assert attached, \
        f"ctrl+n in the agents view did not attach a fresh session:\n{screen}"

    scratch = Scratch("new-session-repl")
    with CaptureProxy() as proxy:
        term = start(binary, scratch, proxy)
        term.pump(2)
        term.send("\x0e")
        attached = term.wait_for("manual mode on", timeout=60)
        screen = term.text()
        term.close()
        _reap_scratch_daemon(scratch)
    scratch.cleanup()
    assert attached, \
        f"ctrl+n in a session did not spawn and attach a fresh session:\n{screen}"


def agents_view_models(binary):
    """An agents-view job row shows the model from its --model respawn flag.

    Two completed job records seeded into the config dir render as Completed
    rows when `claude agents` mounts; patched, their age cells read
    "fable · <age>" and — for a Bedrock-style provider-prefixed id —
    "opus · <age>". Stock renders the ages alone. The sibling patch
    agent-list-models has no hermetic test: its rows require a live subagent
    spawn, which the capture proxy cannot script deterministically.
    """
    scratch = Scratch("agent-model")
    now_ms = int(time.time() * 1000)
    iso = lambda ms: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ms / 1000))
    jobs = [("zzmodel1", "quokka model probe", "claude-fable-5[1m]"),
            ("zzmodel2", "axolotl bedrock probe", "us.anthropic.claude-opus-4-6-20250401-v1:0")]
    for short, intent, model in jobs:
        jobdir = scratch.config / "jobs" / short
        jobdir.mkdir(parents=True)
        (jobdir / "state.json").write_text(json.dumps({
            "state": "done", "detail": "probe finished", "tempo": "idle",
            "inFlight": {"tasks": 0, "queued": 0, "kinds": []},
            "tokens": 1234, "output": {"result": "probe finished"},
            "children": None, "template": "claude",
            "respawnFlags": ["--agent", "claude", "--model", model],
            "intent": intent, "name": intent, "nameSource": "auto",
            "sessionId": f"{short}-0000-4000-8000-000000000000",
            "resumeSessionId": f"{short}-0000-4000-8000-000000000000",
            "daemonShort": short, "cliVersion": "0.0.0",
            "cwd": str(scratch.project), "originCwd": str(scratch.project),
            "backend": "daemon",
            "createdAt": iso(now_ms - 300_000), "updatedAt": iso(now_ms - 60_000),
            "firstTerminalAt": iso(now_ms - 60_000),
        }))
    with CaptureProxy() as proxy:
        env = scratch.env(proxy)
        env.update({"TERM": "xterm-256color", "COLUMNS": str(COLS),
                    "LINES": str(ROWS), "FORCE_COLOR": "0", "NO_COLOR": "1"})
        term = Term([binary, "agents"], env, str(scratch.project))
        if not term.wait_for("quokka model probe", timeout=90):
            screen = term.text()
            term.close()
            _reap_scratch_daemon(scratch)
            scratch.cleanup()
            raise AssertionError(f"the seeded job rows never rendered:\n{screen}")
        term.pump(2)
        screen = term.text()
        term.close()
        _reap_scratch_daemon(scratch)
    scratch.cleanup()
    for intent, family in (("quokka model probe", "fable"),
                           ("axolotl bedrock probe", "opus")):
        row = next((r for r in screen.split("\n") if intent in r), None)
        assert row is not None, f"the {intent!r} row is not on screen:\n{screen}"
        assert f"{family} ·" in row, \
            f"the {intent!r} row shows no {family!r} model:\n{row!r}\n{screen}"


THINKING_MARKER = "zqx-thinking-marker"
# The marker sits at the end so it can only match a fully rendered block: the
# one-line summary stock draws on the group row while a turn streams is
# truncated long before it.
THINKING_TEXT = ("Weighing the request from every angle. " * 5) + THINKING_MARKER


def thinking_turn(binary, scratch, extra_settings=None):
    """Run one turn that thinks and then answers; return the finished screen."""
    if extra_settings:
        scratch.write_settings(**extra_settings)
    script = [[{"thinking": THINKING_TEXT}, {"text": "thinking answered"}]]
    with CaptureProxy(script) as proxy:
        term = start(binary, scratch, proxy)
        term.submit("think it over")
        answered = term.wait_for("thinking answered", timeout=90)
        term.pump(4)
        screen = term.text()
        term.close()
    scratch.cleanup()
    assert answered, f"the turn never completed:\n{screen}"
    return screen


def thinking_visibility(binary):
    """A thinking block's text renders in the normal chat view, in full.

    Stock draws thinking only in transcript mode (ctrl+o) or under --verbose.
    showThinkingSummaries is on, as it is on this install, so the assertion is
    about the block that stays on screen once the turn is done, not the live
    summary line that both builds show while it streams.
    """
    screen = thinking_turn(binary, Scratch("thinking-visible"),
                           {"showThinkingSummaries": True})
    assert THINKING_MARKER in screen, \
        f"the thinking block is not in the normal view:\n{screen}"


def thinking_no_fold(binary):
    """A thinking block is its own transcript entry, not a collapsed pill.

    Stock folds it into the adjacent collapsed read/search group, which renders
    as "Thought for Ns · ctrl+o to expand" — a turn that only thinks and answers
    still gets such a group, opened by the thinking message itself.
    """
    screen = thinking_turn(binary, Scratch("thinking-no-fold"))
    # Asserted before the rendered text on purpose: the pill is stock's own
    # behavior, so it is what a stock failure reason should name.
    assert "Thought for" not in screen, \
        f"the thinking block was folded into a collapsed group:\n{screen}"
    assert THINKING_MARKER in screen, \
        f"the thinking block did not render as its own entry:\n{screen}"


def thinking_latest(binary):
    """The pill keeps a one-line summary of its latest thinking block.

    Two thinking blocks stream in one turn; both fold into one collapsed
    group. Patched, once the turn completes the pill row still shows the
    second block's first line, ellipsis-truncated — the block's tail and the
    earlier block stay hidden. Stock shows no thinking at all once the turn
    is done.
    """
    earlier = "zqx-earlier-lead " + ("padding words here. " * 8)
    latest = "zqx-latest-lead " + ("closing thoughts follow. " * 8) + "zqx-latest-tail"
    scratch = Scratch("thinking-latest")
    script = [[{"thinking": earlier}, {"thinking": latest},
               {"text": "thinking answered"}]]
    with CaptureProxy(script) as proxy:
        term = start(binary, scratch, proxy)
        term.submit("think it over")
        answered = term.wait_for("thinking answered", timeout=90)
        term.pump(4)
        screen = term.text()
        term.close()
    scratch.cleanup()
    assert answered, f"the turn never completed:\n{screen}"
    assert "Thought for" in screen, \
        f"the collapsed group's pill is gone:\n{screen}"
    row = next((r for r in screen.split("\n") if "zqx-latest-lead" in r), None)
    assert row is not None, \
        f"the latest thinking block's first line is not on the pill row:\n{screen}"
    assert "…" in row, \
        f"the thinking line is not ellipsis-truncated:\n{row!r}\n{screen}"
    assert "zqx-latest-tail" not in screen, \
        f"more than the first line rendered:\n{screen}"
    assert "zqx-earlier-lead" not in screen, \
        f"an earlier thinking block rendered too:\n{screen}"


TESTS = {
    "no-collapse-tool-calls": no_collapse_tool_calls,
    "toolsearch-visibility": toolsearch_visibility,
    "cron-visibility": cron_visibility,
    "agents-view-shortcut": agents_view_shortcut,
    "new-session-shortcut": new_session_shortcut,
    "agents-view-models": agents_view_models,
    "thinking-visibility": thinking_visibility,
    "thinking-no-fold": thinking_no_fold,
    "thinking-latest": thinking_latest,
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
    except Exception as exc:
        print(f"FAIL {test_id}: {type(exc).__name__}: {exc}")
        sys.exit(1)
    print(f"pass {test_id}")
