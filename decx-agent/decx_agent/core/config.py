from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from ..decx.server import DEFAULT_PORT


ServerMode = Literal["external", "managed", "disabled"]


@dataclass(frozen=True, slots=True)
class ServerConfig:
    mode: ServerMode = "external"
    port: int = DEFAULT_PORT
    jar: str | None = None
    timeout: int = 120


@dataclass(frozen=True, slots=True)
class AgentConfig:
    server: ServerConfig = ServerConfig()


def load_agent_config(project_root: str | Path, config_path: str | Path | None = None) -> AgentConfig:
    path = Path(config_path) if config_path else Path(project_root) / "decx-agent.json"
    if not path.exists():
        return AgentConfig()
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"agent config must be a JSON object: {path}")
    return AgentConfig(server=parse_server_config(data.get("server") or {}))


def parse_server_config(data: Any) -> ServerConfig:
    if not isinstance(data, dict):
        raise ValueError("server config must be an object")
    mode = str(data.get("mode", "external"))
    if mode not in {"external", "managed", "disabled"}:
        raise ValueError("server.mode must be external, managed, or disabled")
    return ServerConfig(
        mode=mode,
        port=int(data.get("port", DEFAULT_PORT)),
        jar=data.get("jar"),
        timeout=int(data.get("timeout", 120)),
    )
