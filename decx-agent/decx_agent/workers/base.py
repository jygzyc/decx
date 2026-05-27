from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class WorkerResult:
    worker: str
    stdout: str
    stderr: str = ""
    returncode: int = 0


@dataclass(frozen=True, slots=True)
class WorkerRequest:
    task: str
    prompt: str
    cwd: Path
    references: tuple[Path, ...] = ()
    session: str | None = None


class WorkerDriver:
    name = "base"

    def execute(self, request: WorkerRequest) -> WorkerResult:
        raise NotImplementedError
