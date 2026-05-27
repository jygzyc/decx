from __future__ import annotations

import os

from .base import WorkerRequest
from .command import CommandDriver


class OpenCodeDriver(CommandDriver):
    name = "opencode"

    def __init__(self, model: str | None = None):
        super().__init__(env={"XDG_CACHE_HOME": os.environ.get("XDG_CACHE_HOME", "/private/tmp/opencode-cache")})
        self.model = model

    def build_argv(self, request: WorkerRequest) -> list[str]:
        argv = ["opencode", "run", "--dangerously-skip-permissions"]
        if self.model:
            argv.extend(["--model", self.model])
        if request.session:
            argv.extend(["--session", request.session])
        argv.append(request.prompt)
        return argv
