# Scratch Claude Code sessions for the functional suite: an isolated config dir
# and project dir per test, so a run never sees the user's settings, MCP
# servers, hooks or CLAUDE.md, and every assertion is about the binary alone.
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

TESTS = pathlib.Path(__file__).resolve().parent
NODE = shutil.which("node") or "/opt/homebrew/bin/node"


class Scratch:
    """An isolated config + project pair for one test."""

    def __init__(self, name):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix=f"cc-suite-{name}-"))
        self.config = self.root / "config"
        self.project = self.root / "project"
        self.config.mkdir()
        self.project.mkdir()
        self.settings = {}
        self.write_settings(theme="dark", includeCoAuthoredBy=False)
        self.skip_onboarding()

    def skip_onboarding(self):
        """Pre-accept the first-run wizard and the folder-trust dialog.

        Without this the TUI opens on the theme picker and never reaches a
        prompt, and headless runs stop on the trust question.
        """
        projects = {str(path): {"hasTrustDialogAccepted": True,
                                "hasCompletedProjectOnboarding": True,
                                "allowedTools": []}
                    for path in {self.project, self.project.resolve()}}
        (self.config / ".claude.json").write_text(json.dumps({
            "hasCompletedOnboarding": True,
            "bypassPermissionsModeAccepted": True,
            "theme": "dark",
            "numStartups": 20,
            "projects": projects,
        }))

    def use_subdir(self, name):
        """Run the session from a subdirectory of the project."""
        self.project = self.project / name
        self.project.mkdir(parents=True, exist_ok=True)
        self.skip_onboarding()

    def write_settings(self, **extra):
        self.settings.update(extra)
        (self.config / "settings.json").write_text(json.dumps(self.settings))

    def add_mcp_server(self, name, log):
        """Register the fixture stdio MCP server, whose tools are deferrable."""
        (self.project / ".mcp.json").write_text(json.dumps({"mcpServers": {name: {
            "type": "stdio",
            "command": NODE,
            "args": [str(TESTS / "mcp-per-subagent" / "logsrv.js")],
            "env": {"LOGSRV_LOG": str(log)},
        }}}))
        self.write_settings(enableAllProjectMcpServers=True)

    def env(self, proxy, extra=None):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("CLAUDE") and k != "CLAUDECODE"}
        env["CLAUDE_CONFIG_DIR"] = str(self.config)
        env.update(proxy.env_for(extra))
        return env

    def run(self, binary, proxy, prompt, extra_env=None, args=(), timeout=180):
        return subprocess.run(
            [binary, "-p", "--model", "sonnet",
             "--permission-mode", "bypassPermissions", *args, prompt],
            env=self.env(proxy, extra_env), cwd=str(self.project),
            capture_output=True, text=True, timeout=timeout)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)
