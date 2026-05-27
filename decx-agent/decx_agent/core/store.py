from __future__ import annotations

import json
from pathlib import Path

from .board import Project


RUN_FILE = "run.json"


def project_path(project: Project) -> Path:
    return Path(project.artifact_dir).joinpath(RUN_FILE)


def save_project(project: Project) -> None:
    path = project_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(project.to_dict(), indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def load_project(path: str | Path) -> Project:
    run_path = Path(path)
    if run_path.is_dir():
        run_path = run_path / RUN_FILE
    return Project.from_dict(json.loads(run_path.read_text(encoding="utf-8")))
