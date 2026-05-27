from __future__ import annotations

import json
import re
from typing import Any, Literal


TaskKind = Literal["bootstrap", "reason", "explore"]


def extract_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    if not text:
        raise ValueError("worker output is empty")
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("worker output does not contain a JSON object")
    value = json.loads(match.group(0))
    if not isinstance(value, dict):
        raise ValueError("worker output JSON must be an object")
    return value


def require_text(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value.strip()


def validate_worker_payload(kind: TaskKind, output: str) -> tuple[str, dict[str, Any]]:
    payload = extract_json_object(output)
    accepted = payload.get("accepted", True)
    if accepted is False:
        return "rejected", {}
    if accepted is not True:
        raise ValueError("accepted must be true or false")
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise ValueError("data must be an object")

    if kind == "bootstrap":
        fact = data.get("fact")
        if not isinstance(fact, dict):
            raise ValueError("data.fact is required")
        require_text(fact, "description")
        probes = validate_probes(data)
        intents = data.get("intents", [])
        if intents is not None and not isinstance(intents, list):
            raise ValueError("data.intents must be an array")
        for index, intent in enumerate(intents or []):
            if not isinstance(intent, dict):
                raise ValueError(f"data.intents[{index}] must be an object")
            require_text(intent, "description")
        data["probes"] = probes
        return "fact", data

    if kind == "explore":
        fact = data.get("fact", data)
        if not isinstance(fact, dict):
            raise ValueError("data.fact must be an object")
        require_text(fact, "description")
        return "fact", {"fact": fact, "probes": validate_probes(data)}

    if kind == "reason":
        if "complete" in data:
            complete = data["complete"]
            if not isinstance(complete, dict):
                raise ValueError("data.complete must be an object")
            require_text(complete, "description")
            return "complete", {"complete": complete}
        intents = data.get("intents", [])
        if "intent" in data and not intents:
            intents = [data["intent"]]
        if intents is None:
            intents = []
        if not isinstance(intents, list):
            raise ValueError("data.intents must be an array")
        for index, intent in enumerate(intents):
            if not isinstance(intent, dict):
                raise ValueError(f"data.intents[{index}] must be an object")
            require_text(intent, "description")
        return "intents", {"intents": intents}

    raise ValueError(f"unknown task kind: {kind}")


def validate_probes(data: dict[str, Any]) -> list[dict[str, Any]]:
    probes = data.get("probes", [])
    if probes is None:
        return []
    if not isinstance(probes, list):
        raise ValueError("data.probes must be an array")
    validated: list[dict[str, Any]] = []
    for index, probe in enumerate(probes):
        if not isinstance(probe, dict):
            raise ValueError(f"data.probes[{index}] must be an object")
        name = probe.get("name") or probe.get("endpoint")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"data.probes[{index}].name is required")
        payload = probe.get("payload", {})
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ValueError(f"data.probes[{index}].payload must be an object")
        validated.append({"name": name.strip(), "payload": payload})
    return validated
