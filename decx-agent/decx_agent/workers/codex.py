from __future__ import annotations

from .base import WorkerRequest
from .command import CommandDriver


class CodexDriver(CommandDriver):
    name = "codex"

    def __init__(self, model: str | None = None):
        super().__init__()
        self.model = model

    def build_argv(self, request: WorkerRequest) -> list[str]:
        argv = ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"]
        if self.model:
            argv.extend(["--model", self.model])
        argv.extend(["--", request.prompt])
        return argv
