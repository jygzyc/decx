from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4


ProjectStatus = Literal["active", "completed", "stopped"]
IntentStatus = Literal["open", "claimed", "concluded"]
TaskType = Literal["bootstrap", "reason", "explore"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_name(value: str) -> str:
    text = "".join(char if char.isalnum() or char in "._-" else "-" for char in value)
    text = text.strip("-._")
    return text[:80] or "target"


def target_name(target: str) -> str:
    path = Path(target)
    return safe_name(path.stem or path.name or target)


@dataclass(slots=True)
class Fact:
    id: str
    description: str
    source: str = "dispatcher"
    created_at: str = field(default_factory=now_iso)
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "description": self.description,
            "source": self.source,
            "createdAt": self.created_at,
            "evidence": self.evidence,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Fact":
        return Fact(
            id=str(data["id"]),
            description=str(data["description"]),
            source=str(data.get("source", "dispatcher")),
            created_at=str(data.get("createdAt", now_iso())),
            evidence=list(data.get("evidence") or []),
        )


@dataclass(slots=True)
class Intent:
    id: str
    from_ids: list[str]
    description: str
    creator: str
    to: str | None = None
    worker: str | None = None
    created_at: str = field(default_factory=now_iso)
    claimed_at: str | None = None
    concluded_at: str | None = None

    @property
    def status(self) -> IntentStatus:
        if self.to:
            return "concluded"
        if self.worker:
            return "claimed"
        return "open"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "from": self.from_ids,
            "to": self.to,
            "description": self.description,
            "creator": self.creator,
            "worker": self.worker,
            "status": self.status,
            "createdAt": self.created_at,
            "claimedAt": self.claimed_at,
            "concludedAt": self.concluded_at,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Intent":
        return Intent(
            id=str(data["id"]),
            from_ids=list(data.get("from") or data.get("from_ids") or []),
            to=data.get("to"),
            description=str(data["description"]),
            creator=str(data.get("creator", "dispatcher")),
            worker=data.get("worker"),
            created_at=str(data.get("createdAt", now_iso())),
            claimed_at=data.get("claimedAt"),
            concluded_at=data.get("concludedAt"),
        )


@dataclass(slots=True)
class Hint:
    id: str
    content: str
    creator: str = "user"
    created_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "creator": self.creator,
            "createdAt": self.created_at,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Hint":
        return Hint(
            id=str(data["id"]),
            content=str(data["content"]),
            creator=str(data.get("creator", "user")),
            created_at=str(data.get("createdAt", now_iso())),
        )


@dataclass(slots=True)
class Project:
    id: str
    title: str
    target: str
    mode: str
    port: int | None
    artifact_dir: str
    status: ProjectStatus = "active"
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    facts: list[Fact] = field(default_factory=list)
    intents: list[Intent] = field(default_factory=list)
    hints: list[Hint] = field(default_factory=list)
    worker_runs: list[dict[str, Any]] = field(default_factory=list)

    def next_fact_id(self) -> str:
        numbers = [
            int(fact.id[1:])
            for fact in self.facts
            if fact.id.startswith("f") and fact.id[1:].isdigit()
        ]
        return f"f{(max(numbers) + 1) if numbers else 1:03d}"

    def next_intent_id(self) -> str:
        numbers = [
            int(intent.id[1:])
            for intent in self.intents
            if intent.id.startswith("i") and intent.id[1:].isdigit()
        ]
        return f"i{(max(numbers) + 1) if numbers else 1:03d}"

    def add_fact(self, description: str, *, source: str, evidence: list[str] | None = None, fact_id: str | None = None) -> Fact:
        fact = Fact(
            id=fact_id or self.next_fact_id(),
            description=description.strip(),
            source=source,
            evidence=evidence or [],
        )
        self.facts.append(fact)
        self.updated_at = now_iso()
        return fact

    def add_intent(self, description: str, *, from_ids: list[str], creator: str) -> Intent:
        intent = Intent(
            id=self.next_intent_id(),
            from_ids=from_ids,
            description=description.strip(),
            creator=creator,
        )
        self.intents.append(intent)
        self.updated_at = now_iso()
        return intent

    def add_hint(self, content: str, *, creator: str = "user") -> Hint:
        hint = Hint(
            id=f"h{len(self.hints) + 1:03d}",
            content=content.strip(),
            creator=creator.strip() or "user",
        )
        self.hints.append(hint)
        self.updated_at = now_iso()
        return hint

    def open_intents(self) -> list[Intent]:
        return [intent for intent in self.intents if intent.status == "open"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "project": {
                "id": self.id,
                "title": self.title,
                "target": self.target,
                "mode": self.mode,
                "port": self.port,
                "artifactDir": self.artifact_dir,
                "status": self.status,
                "createdAt": self.created_at,
                "updatedAt": self.updated_at,
            },
            "facts": [fact.to_dict() for fact in self.facts],
            "intents": [intent.to_dict() for intent in self.intents],
            "hints": [hint.to_dict() for hint in self.hints],
            "workerRuns": self.worker_runs,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Project":
        meta = data["project"]
        return Project(
            id=str(meta["id"]),
            title=str(meta["title"]),
            target=str(meta["target"]),
            mode=str(meta["mode"]),
            port=meta.get("port"),
            artifact_dir=str(meta["artifactDir"]),
            status=meta.get("status", "active"),
            created_at=str(meta.get("createdAt", now_iso())),
            updated_at=str(meta.get("updatedAt", now_iso())),
            facts=[Fact.from_dict(item) for item in data.get("facts", [])],
            intents=[Intent.from_dict(item) for item in data.get("intents", [])],
            hints=[Hint.from_dict(item) for item in data.get("hints", [])],
            worker_runs=list(data.get("workerRuns") or []),
        )


def new_project(*, target: str, mode: str, port: int | None, artifact_root: str) -> Project:
    name = target_name(target)
    artifact_dir = str(Path(artifact_root).joinpath(name))
    project = Project(
        id=f"{name}-{uuid4().hex[:8]}",
        title=f"DECX analysis for {name}",
        target=target,
        mode=mode,
        port=port,
        artifact_dir=artifact_dir,
    )
    project.add_fact(
        f"Origin: run DECX agent on target `{target}` with mode `{mode}` and port `{port or 'unset'}`.",
        source="origin",
        fact_id="origin",
    )
    project.add_fact(
        "Goal: grow evidence-backed facts until Android vulnerabilities are statically supported or rejected.",
        source="goal",
        fact_id="goal",
    )
    project.add_intent(
        "bootstrap: enumerate the first useful attack-surface facts and propose the next DECX exploration intents.",
        from_ids=["origin", "goal"],
        creator="dispatcher.bootstrap",
    )
    return project
