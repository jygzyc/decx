from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import DecxCoreClient


DEFAULT_PORT = 25419


class DecxServerError(RuntimeError):
    pass


@dataclass(slots=True)
class ServerManager:
    project_root: Path
    artifact_root: Path

    def check(self, *, port: int = DEFAULT_PORT) -> dict[str, Any]:
        state = self._read_state(port)
        try:
            health = DecxCoreClient(port=port, timeout=2).call("health")
            return {"ok": True, "port": port, "health": health, "state": state}
        except Exception as exc:
            return {"ok": False, "port": port, "error": str(exc), "state": state}

    def open(self, target: str, *, port: int = DEFAULT_PORT, jar: str | None = None, name: str | None = None, timeout: int = 120) -> dict[str, Any]:
        running = self.check(port=port)
        if running["ok"]:
            return {"reused": True, **running}

        target_path = Path(target).expanduser().resolve()
        if not target_path.exists():
            raise DecxServerError(f"target not found: {target_path}")

        jar_path = Path(jar).expanduser().resolve() if jar else self._find_jar()
        if not jar_path.exists():
            raise DecxServerError(f"decx-server jar not found: {jar_path}")

        session_name = name or target_path.stem
        log_path = self._log_dir().joinpath(f"{session_name}-{port}.log")
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_file = log_path.open("ab")
        try:
            proc = subprocess.Popen(
                ["java", "-jar", str(jar_path), str(target_path), "--port", str(port), "--show-bad-code"],
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=log_file,
                cwd=self.project_root,
                start_new_session=True,
            )
        finally:
            log_file.close()

        state = {
            "name": session_name,
            "pid": proc.pid,
            "port": port,
            "target": str(target_path),
            "jar": str(jar_path),
            "log": str(log_path),
            "createdAt": int(time.time()),
        }
        self._write_state(port, state)
        if not self._wait(port, timeout, proc):
            raise DecxServerError(f"server did not become healthy on port {port}; log: {log_path}")
        return {"reused": False, "ok": True, **state}

    def close(self, *, port: int = DEFAULT_PORT) -> dict[str, Any]:
        state = self._read_state(port)
        if not state:
            return {"closed": False, "port": port, "reason": "no managed server state"}
        pid = int(state["pid"])
        stopped = self._kill(pid)
        self._state_path(port).unlink(missing_ok=True)
        return {"closed": stopped, "port": port, "pid": pid}

    def _find_jar(self) -> Path:
        decx_server_home = os.environ.get("DECX_SERVER_HOME", "").strip()
        if decx_server_home:
            server_home = Path(decx_server_home).expanduser()
            candidates = [server_home] if server_home.suffix == ".jar" else [server_home / "decx-server.jar"]
        else:
            decx_home = Path(os.environ.get("DECX_HOME", "~/.decx")).expanduser()
            candidates = [decx_home / "bin" / "decx-server.jar"]

        for path in candidates:
            if path.exists():
                return path.resolve()

        searched = ", ".join(str(path) for path in candidates)
        raise DecxServerError(f"decx-server.jar not found in installed locations: {searched}. Install it from GitHub releases with `decx self install`, or set server.jar.")

    def _wait(self, port: int, timeout: int, proc: subprocess.Popen[bytes]) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                return False
            if self.check(port=port)["ok"]:
                return True
            time.sleep(1)
        return False

    def _kill(self, pid: int) -> bool:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            return False
        except PermissionError as exc:
            raise DecxServerError(f"cannot stop process {pid}: {exc}") from exc
        deadline = time.time() + 2
        while time.time() < deadline:
            if not self._alive(pid):
                return True
            time.sleep(0.1)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            return True
        return not self._alive(pid)

    @staticmethod
    def _alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def _state_dir(self) -> Path:
        path = self.artifact_root / "servers"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _log_dir(self) -> Path:
        path = self.artifact_root / "server-logs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _state_path(self, port: int) -> Path:
        return self._state_dir() / f"{port}.json"

    def _read_state(self, port: int) -> dict[str, Any] | None:
        path = self._state_path(port)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_state(self, port: int, state: dict[str, Any]) -> None:
        self._state_path(port).write_text(json.dumps(state, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
