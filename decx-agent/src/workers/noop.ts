/**
 * Noop worker driver: returns canned payloads for every phase.
 * Used for testing and as a fallback when no real worker is configured.
 */

import type { WorkerDriver, WorkerRequest, WorkerResult } from "./registry.js";

export class NoopDriver implements WorkerDriver {
  readonly name: string;

  constructor(name = "noop") {
    this.name = name;
  }

  execute(request: WorkerRequest): WorkerResult {
    return {
      worker: this.name,
      returncode: 0,
      stdout: JSON.stringify(noopPayload(request)),
      stderr: "",
    };
  }
}

function noopPayload(request: WorkerRequest): unknown {
  if (request.phase === "bootstrap") {
    return {
      accepted: true,
      data: {
        fact: {
          description: "noop bootstrap established the initial DECX analysis target and run graph",
          evidence: [],
        },
        events: [{ type: "noop.bootstrap", severity: "info", category: "noop", source: "noop" }],
      },
    };
  }

  if (request.phase === "reason") {
    if (request.prompt.includes("noop explore completed one planned analysis intent")) {
      return {
        accepted: true,
        data: {
          complete: {
            from: ["f002"],
            description: "noop run completed after bootstrap, intent planning, and one exploration step",
          },
        },
      };
    }

    return {
      accepted: true,
      data: {
        intents: [{
          from: ["f001"],
          description: "Enumerate the DECX attack surface and create the first workflow handoff artifact when candidates are found",
        }],
      },
    };
  }

  if (request.phase === "review") {
    return {
      accepted: true,
      data: {
        review: { summary: "noop reviewer found no drift in the current generic agent task", severity: "info" },
        events: [{ type: "review.completed", severity: "info", category: "review", source: "noop" }],
      },
    };
  }

  return {
    accepted: true,
    data: {
      fact: { description: "noop explore completed one planned analysis intent", evidence: [] },
    },
  };
}
