from __future__ import annotations

from .base import WorkerRequest
from .command import CommandDriver


class ClaudeCodeDriver(CommandDriver):
    name = "claude-code"

    def __init__(self, model: str | None = None):
        super().__init__()
        self.model = model

    def build_argv(self, request: WorkerRequest) -> list[str]:
        argv = [
            "claude",
            "--print",
            "--output-format",
            "text",
            "--dangerously-skip-permissions",
            "--no-session-persistence",
        ]
        if self.model:
            argv.extend(["--model", self.model])
        argv.extend(["--", request.prompt])
        return argv
