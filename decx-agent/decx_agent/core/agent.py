from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..decx.client import DecxCoreClient, ProbeResult
from ..decx.server import ServerManager
from ..workers import WorkerDriver, WorkerRequest
from .board import Intent, Project, new_project, now_iso
from .config import AgentConfig
from .protocol import validate_worker_payload
from .prompts import bootstrap_prompt, explore_prompt, reason_prompt
from .skills import SkillBundle, load_skill_bundle
from .store import load_project, save_project


def classify_mode(target: str, requested: str | None) -> str:
    if requested:
        return requested
    text = target.lower()
    if "framework" in text:
        return "framework-vulnhunt"
    return "app-vulnhunt"


@dataclass(slots=True)
class DispatchResult:
    task: str
    worker: str
    status: str
    detail: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "task": self.task,
            "worker": self.worker,
            "status": self.status,
            "detail": self.detail,
        }


class DecxAgent:
    def __init__(self, *, project_root: str | Path, worker: WorkerDriver, artifact_root: str = ".decx-analysis", config: AgentConfig | None = None):
        self.project_root = Path(project_root)
        self.worker = worker
        artifact_path = Path(artifact_root)
        self.artifact_root = str(artifact_path if artifact_path.is_absolute() else self.project_root / artifact_path)
        self.config = config or AgentConfig()

    def create(self, *, target: str, mode: str | None = None, port: int | None = None) -> Project:
        project = new_project(
            target=target,
            mode=classify_mode(target, mode),
            port=port,
            artifact_root=self.artifact_root,
        )
        save_project(project)
        return project

    def load(self, run_path: str | Path) -> Project:
        return load_project(run_path)

    def run_target(self, *, target: str, mode: str | None = None, port: int | None = None, dry_run: bool = False, max_steps: int = 8) -> tuple[Project, list[DispatchResult]]:
        port = self._prepare_server(target, port)
        project = self.create(target=target, mode=mode, port=port)
        if dry_run:
            return project, []
        return self.run(project, max_steps=max_steps)

    def resume(self, *, run_path: str | Path, dry_run: bool = False, max_steps: int = 8) -> tuple[Project, list[DispatchResult]]:
        project = self.load(run_path)
        if dry_run:
            return project, []
        return self.run(project, max_steps=max_steps)

    def add_hint(self, *, run_path: str | Path, content: str, creator: str = "user") -> Project:
        project = self.load(run_path)
        project.add_hint(content, creator=creator)
        save_project(project)
        return project

    def run(self, project: Project, *, max_steps: int) -> tuple[Project, list[DispatchResult]]:
        results: list[DispatchResult] = []
        for _ in range(max(1, max_steps)):
            if project.status != "active":
                break
            result = self.step(project)
            save_project(project)
            if result is None:
                break
            results.append(result)
        return project, results

    def step(self, project: Project) -> DispatchResult | None:
        bootstrap = self._open_bootstrap(project)
        if bootstrap is not None:
            return self._run_bootstrap(project, bootstrap)

        open_intents = [intent for intent in project.open_intents() if not self._is_bootstrap(intent)]
        if open_intents:
            return self._run_explore(project, open_intents[0])

        return self._run_reason(project)

    def _run_bootstrap(self, project: Project, intent: Intent) -> DispatchResult:
        intent.worker = self.worker.name
        intent.claimed_at = now_iso()
        result = self._execute_worker(project, "bootstrap", bootstrap_prompt)
        project.worker_runs.append(self._worker_run("bootstrap", result))
        failure = self._worker_failure(project, intent, "bootstrap", result)
        if failure is not None:
            return failure
        kind, data = validate_worker_payload("bootstrap", result.stdout)
        if kind == "rejected":
            intent.worker = None
            return DispatchResult("bootstrap", result.worker, "rejected", {})
        fact = self._add_worker_fact(project, result.worker, data["fact"])
        probe_facts = self._run_probes(project, data.get("probes") or [])
        intent.to = fact.id
        intent.concluded_at = now_iso()
        for item in data.get("intents") or []:
            project.add_intent(item["description"], from_ids=[fact.id], creator=result.worker)
        return DispatchResult("bootstrap", result.worker, "done", {"fact": fact.id, "probeFacts": probe_facts})

    def _run_explore(self, project: Project, intent: Intent) -> DispatchResult:
        intent.worker = self.worker.name
        intent.claimed_at = now_iso()
        result = self._execute_worker(project, "explore", explore_prompt, intent)
        project.worker_runs.append(self._worker_run("explore", result, intent_id=intent.id))
        failure = self._worker_failure(project, intent, "explore", result, intent_id=intent.id)
        if failure is not None:
            return failure
        kind, data = validate_worker_payload("explore", result.stdout)
        if kind == "rejected":
            intent.worker = None
            return DispatchResult("explore", result.worker, "rejected", {"intent": intent.id})
        fact = self._add_worker_fact(project, result.worker, data["fact"])
        probe_facts = self._run_probes(project, data.get("probes") or [])
        intent.to = fact.id
        intent.concluded_at = now_iso()
        return DispatchResult("explore", result.worker, "done", {"intent": intent.id, "fact": fact.id, "probeFacts": probe_facts})

    def _run_reason(self, project: Project) -> DispatchResult | None:
        result = self._execute_worker(project, "reason", reason_prompt)
        project.worker_runs.append(self._worker_run("reason", result))
        if result.returncode != 0:
            return DispatchResult("reason", result.worker, "failed", {"stderr": result.stderr})
        kind, data = validate_worker_payload("reason", result.stdout)
        if kind == "complete":
            complete = data["complete"]
            project.status = "completed"
            project.add_fact(
                complete["description"],
                source=result.worker,
                evidence=list(complete.get("from") or []),
            )
            return DispatchResult("reason", result.worker, "completed", {})
        created = []
        for item in data.get("intents") or []:
            from_ids = list(item.get("from") or [project.facts[-1].id])
            created.append(project.add_intent(item["description"], from_ids=from_ids, creator=result.worker).id)
        if not created:
            return None
        return DispatchResult("reason", result.worker, "done", {"intents": created})

    @staticmethod
    def _worker_run(task: str, result: Any, *, intent_id: str | None = None) -> dict[str, Any]:
        return {
            "task": task,
            "intentId": intent_id,
            "worker": result.worker,
            "returncode": result.returncode,
            "stdoutPreview": result.stdout[:1000],
            "stderrPreview": result.stderr[:1000],
            "createdAt": now_iso(),
        }

    @staticmethod
    def _is_bootstrap(intent: Intent) -> bool:
        return intent.creator == "dispatcher.bootstrap" or intent.description.strip().lower().startswith("bootstrap:")

    def _open_bootstrap(self, project: Project) -> Intent | None:
        for intent in project.open_intents():
            if self._is_bootstrap(intent):
                return intent
        return None

    def _skills(self, project: Project) -> SkillBundle:
        return load_skill_bundle(self.project_root, project.mode)

    def _worker_request(self, task: str, prompt: str, skills: SkillBundle) -> WorkerRequest:
        return WorkerRequest(
            task=task,
            prompt=prompt,
            cwd=self.project_root,
            references=tuple(ref.path for ref in skills.references()),
        )

    def _execute_worker(self, project: Project, task: str, prompt_builder: Any, *args: Any):
        skills = self._skills(project)
        prompt = prompt_builder(project, *args, skills)
        return self.worker.execute(self._worker_request(task, prompt, skills))

    @staticmethod
    def _worker_failure(project: Project, intent: Intent, task: str, result: Any, *, intent_id: str | None = None) -> DispatchResult | None:
        if result.returncode == 0:
            return None
        intent.worker = None
        detail = {"stderr": result.stderr}
        if intent_id is not None:
            detail["intent"] = intent_id
        return DispatchResult(task, result.worker, "failed", detail)

    @staticmethod
    def _add_worker_fact(project: Project, worker: str, fact_data: dict[str, Any]):
        return project.add_fact(
            fact_data["description"],
            source=worker,
            evidence=list(fact_data.get("evidence") or []),
        )

    def _run_probes(self, project: Project, probes: list[dict[str, Any]]) -> list[str]:
        if not probes:
            return []
        if project.port is None:
            fact = project.add_fact(
                f"Skipped {len(probes)} DECX core probe(s) because no DECX port is set.",
                source="dispatcher.probe",
            )
            return [fact.id]

        client = DecxCoreClient(port=project.port)
        fact_ids: list[str] = []
        for probe in probes:
            result = client.probe(probe)
            fact_ids.append(self._add_probe_fact(project, result).id)
        return fact_ids

    @staticmethod
    def _add_probe_fact(project: Project, result: ProbeResult):
        if result.ok:
            description = f"DECX core probe `{result.name}` returned {summarize_value(result.result)}."
        else:
            description = f"DECX core probe `{result.name}` failed: {result.error}"
        evidence = [json.dumps(result.to_dict(), ensure_ascii=True, sort_keys=True)[:8000]]
        return project.add_fact(description, source="dispatcher.probe", evidence=evidence)

    def _prepare_server(self, target: str, port: int | None) -> int | None:
        if port is not None:
            return port
        server = self.config.server
        if server.mode == "disabled":
            return None
        if server.mode == "managed":
            ServerManager(project_root=self.project_root, artifact_root=Path(self.artifact_root)).open(
                target,
                port=server.port,
                jar=server.jar,
                timeout=server.timeout,
            )
        return server.port


def summarize_value(value: Any) -> str:
    if isinstance(value, dict):
        keys = ", ".join(str(key) for key in list(value)[:8])
        return f"object keys [{keys}]" if keys else "an empty object"
    if isinstance(value, list):
        return f"list with {len(value)} item(s)"
    return type(value).__name__
