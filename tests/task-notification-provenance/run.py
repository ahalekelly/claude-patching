#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""task-notification-provenance: notifications say what triggered the run.

    run.py <binary>

Spawns a real headless session (live model) that launches one background
subagent, waits for its first task-notification, then messages the finished
agent with SendMessage so it resumes and notifies a second time. The two
notifications are read back out of the session transcript.

Patched, every agent task-notification carries a <trigger> element: the first
says the run was the original launch ("first stop of the original run"), the
second names the resume trigger and quotes the message ("a message from the
main conversation (SendMessage)" plus the pong prompt). Stock notifications
have no <trigger> at all — the negative control — which is the ambiguity the
patch exists to remove: a finished original run and a user-message resume are
otherwise indistinguishable to the owning agent.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

PING = "Reply with exactly: ping. Do not use any tools."
# The agent's reply, "pong", is echoed in <result> and <summary>, so only the
# whole instruction proves the trigger quoted the message that resumed it.
QUOTED = "Reply with exactly: pong"
PONG = f"{QUOTED}. Do not use any tools."
PROMPT = (
    "Follow these steps exactly. Step 1: use the Agent tool to launch exactly one "
    "subagent with subagent_type 'general-purpose', model 'sonnet', "
    f"run_in_background true, and the prompt: '{PING}' Step 2: after launching it, "
    "call no other tools and end your turn with the single word WAITING; a "
    "task-notification will arrive by itself when the agent finishes. Step 3: when "
    "the first task-notification for that agent arrives, use the SendMessage tool "
    "to send that same agent (the name from the Agent tool result) exactly this "
    f"message: '{PONG}' Then end your turn with the single word SENT. Step 4: when "
    "the second task-notification for that agent arrives, reply with the single "
    "word DONE."
)


def transcript_notifications(config_dir, cwd):
    """Every <task-notification> block in the session transcripts for cwd, in
    the order the session received them. Ordering is what the assertions turn
    on, and transcript filenames are UUIDs, so blocks are keyed on the entry's
    own timestamp rather than on any filename or file order. The project-dir
    name is the session's canonicalized cwd with every non-alphanumeric
    character turned into a dash, so resolve symlinks (/tmp, /var) first."""
    munged = re.sub(r"[^A-Za-z0-9]", "-", str(pathlib.Path(cwd).resolve()))
    project = pathlib.Path(config_dir) / "projects" / munged
    stamped = []
    for jsonl in project.glob("*.jsonl"):
        for seq, line in enumerate(jsonl.read_text().splitlines()):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            strings = []
            walk(entry, strings)
            timestamp = entry.get("timestamp", "") if isinstance(entry, dict) else ""
            for s in strings:
                for block in re.findall(
                    r"<task-notification>.*?</task-notification>", s, re.S
                ):
                    stamped.append((timestamp, seq, block))
    return [block for _, _, block in sorted(stamped, key=lambda item: item[:2])]


def trigger_of(block):
    """The block's <trigger> element, or None. Assertions read this rather than
    the whole block: the agent's own reply is quoted in <result> and <summary>,
    so a phrase found anywhere in the block proves nothing about attribution."""
    found = re.search(r"<trigger>.*?</trigger>", block, re.S)
    return found.group(0) if found else None


def walk(node, out):
    if isinstance(node, str):
        if "<task-notification>" in node:
            out.append(node)
    elif isinstance(node, list):
        for item in node:
            walk(item, out)
    elif isinstance(node, dict):
        for value in node.values():
            walk(value, out)


def main():
    binary = sys.argv[1]
    root = pathlib.Path(tempfile.mkdtemp(prefix="cc-task-notif-prov-"))

    # The nested session must not inherit this session's identity; CLAUDE_CONFIG_DIR
    # is the one CLAUDE_* variable it still needs, for authentication.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("CLAUDE") and k != "CLAUDECODE"}
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))
    env["CLAUDE_CONFIG_DIR"] = config_dir

    try:
        run = subprocess.run(
            [binary, "-p", "--model", "sonnet", "--permission-mode", "bypassPermissions",
             "--output-format", "json", PROMPT],
            cwd=str(root), env=env, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as expired:
        seen = transcript_notifications(config_dir, root)
        shutil.rmtree(root, ignore_errors=True)
        print("FAIL task-notification-provenance: the session did not finish within "
              f"{expired.timeout}s; {len(seen)} notification(s) reached the transcript"
              f"\nnotifications seen:\n" + ("\n---\n".join(seen) or "(none)"))
        return 1

    notifications = transcript_notifications(config_dir, root)
    shutil.rmtree(root, ignore_errors=True)

    def dump():
        joined = "\n---\n".join(notifications) or "(none)"
        return (f"\nnotifications seen:\n{joined}\n"
                f"stdout tail: {run.stdout[-600:]}\nstderr tail: {run.stderr[-600:]}")

    triggers = [t for t in map(trigger_of, notifications) if t]
    if len(notifications) < 2 or len(triggers) < 2:
        print(f"FAIL task-notification-provenance: {len(notifications)} notification(s), "
              f"{len(triggers)} with a <trigger> element, expected 2+ of each"
              + dump())
        return 1

    problems = []
    if "first stop of the original run" not in triggers[0]:
        problems.append("the earliest notification does not attribute the run to the "
                        "original launch")
    resumed = [t for t in triggers[1:]
               if "a message from the main conversation (SendMessage)" in t]
    if not resumed:
        problems.append("no later notification attributes its run to a SendMessage "
                        "from the main conversation")
    elif QUOTED not in resumed[0]:
        problems.append("the resume notification does not quote the message text")

    if problems:
        print("FAIL task-notification-provenance: " + "; ".join(problems) + dump())
        return 1
    print("pass task-notification-provenance")
    return 0


if __name__ == "__main__":
    sys.exit(main())
