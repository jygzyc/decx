from __future__ import annotations

from .base import WorkerDriver, WorkerRequest, WorkerResult


class NoopDriver(WorkerDriver):
    name = "noop"

    def execute(self, request: WorkerRequest) -> WorkerResult:
        if request.task == "reason":
            output = '{"accepted": true, "data": {"intents": []}}'
        elif request.task == "explore":
            output = '{"accepted": true, "data": {"fact": {"description": "noop explored the assigned DECX intent; replace with a real worker for evidence."}}}'
        else:
            output = (
                '{"accepted": true, "data": {'
                '"fact": {"description": "noop bootstrap created the initial DECX analysis board."}, '
                '"intents": [{"description": "Inspect the primary externally reachable surface and record the first evidence-backed fact."}]'
                "}}"
            )
        return WorkerResult(worker=self.name, stdout=output)
