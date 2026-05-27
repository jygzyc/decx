from __future__ import annotations

import json
import os
import subprocess

from .base import WorkerDriver, WorkerRequest, WorkerResult


class CommandDriver(WorkerDriver):
    timeout = 900

    def __init__(self, *, env: dict[str, str] | None = None, timeout: int | None = None):
        self.env = env or {}
        if timeout is not None:
            self.timeout = timeout

    def build_argv(self, request: WorkerRequest) -> list[str]:
        raise NotImplementedError

    def execute(self, request: WorkerRequest) -> WorkerResult:
        env = self._env(request)
        try:
            result = subprocess.run(
                self.build_argv(request),
                text=True,
                capture_output=True,
                env=env,
                cwd=request.cwd,
                check=False,
                timeout=self.timeout,
            )
        except FileNotFoundError as exc:
            return WorkerResult(worker=self.name, stdout="", stderr=str(exc), returncode=127)
        except subprocess.TimeoutExpired as exc:
            stderr = (exc.stderr or "") if isinstance(exc.stderr, str) else ""
            return WorkerResult(worker=self.name, stdout=exc.stdout or "", stderr=f"worker timed out after {self.timeout}s\n{stderr}".strip(), returncode=124)

        return WorkerResult(
            worker=self.name,
            stdout=result.stdout,
            stderr=result.stderr,
            returncode=result.returncode,
        )

    def _env(self, request: WorkerRequest) -> dict[str, str]:
        env = os.environ.copy()
        env.update(self.env)
        references = [str(path) for path in request.references]
        env["DECX_WORKER"] = self.name
        env["DECX_WORKER_TASK"] = request.task
        env["DECX_WORKER_REFERENCES"] = os.pathsep.join(references)
        env["DECX_WORKER_REFERENCES_JSON"] = json.dumps(references, ensure_ascii=True)
        if request.session:
            env["DECX_WORKER_SESSION"] = request.session
        return env
