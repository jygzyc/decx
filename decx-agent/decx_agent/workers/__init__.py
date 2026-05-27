from __future__ import annotations

from .base import WorkerDriver, WorkerRequest, WorkerResult
from .claude_code import ClaudeCodeDriver
from .codex import CodexDriver
from .noop import NoopDriver
from .opencode import OpenCodeDriver


def create_driver(name: str, *, model: str | None = None) -> WorkerDriver:
    normalized = name.strip().lower()
    if normalized == "noop":
        return NoopDriver()
    if normalized == "codex":
        return CodexDriver(model)
    if normalized in {"claude", "claude-code"}:
        return ClaudeCodeDriver(model)
    if normalized == "opencode":
        return OpenCodeDriver(model)
    raise ValueError(f"unknown worker: {name}")


def supported_workers() -> list[str]:
    return ["noop", "codex", "claude-code", "opencode"]


__all__ = [
    "ClaudeCodeDriver",
    "CodexDriver",
    "NoopDriver",
    "OpenCodeDriver",
    "WorkerDriver",
    "WorkerRequest",
    "WorkerResult",
    "create_driver",
    "supported_workers",
]
