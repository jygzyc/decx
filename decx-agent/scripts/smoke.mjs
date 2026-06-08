import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(new URL("..", import.meta.url).pathname);
const workspace = mkdtempSync(join(tmpdir(), "decx-agent-smoke-"));
const taskPath = join(workspace, "task.json");
const dbPath = join(workspace, "agent.sqlite");
const badTaskPath = join(workspace, "bad-task.json");
const badDbPath = join(workspace, "bad-agent.sqlite");
const modelTaskPath = join(workspace, "model-task.json");
const modelDbPath = join(workspace, "model-agent.sqlite");
const promptsDir = join(workspace, "prompts");

try {
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "explorer.md"), "noop explore agent backed by markdown");
  writeFileSync(taskPath, JSON.stringify({
    task: {
      name: "smoke",
      session: "smoke-session",
      target: "input",
      goal: "Verify external config execution",
    },
    worker: "noop",
    tools: {
      notes: {
        kind: "tool",
        description: "Record concise task notes",
        instructions: "Use notes only for facts that affect the current task.",
      },
      guide: {
        kind: "skill",
        description: "Smoke-test skill description",
        promptText: "Keep the smoke task constrained and deterministic.",
      },
    },
    agents: {
      smokeExplorer: {
        extends: "explorer",
        prompt: "prompts/explorer.md",
        worker: "noop",
        tools: ["notes", "guide"],
        autonomy: {
          canCreateIntents: true,
          maxIntentsPerStep: 1,
        },
      },
    },
    workflow: {
      phases: [
        { id: "bootstrap", agent: "planner" },
        { id: "reason", agent: "dispatcher" },
        { id: "explore", agent: "smokeExplorer" },
        { id: "review", agent: "reviewer" },
      ],
      review: {
        enabled: true,
        role: "reviewer",
        worker: "noop",
        everySteps: 1,
      },
      rules: [{
        id: "noop-bootstrap",
        when: { eventType: "noop.bootstrap" },
        then: [{
          createIntent: {
            description: "workflow-created smoke intent",
            agent: "smokeExplorer",
            promptText: "workflow intent prompt text",
            fromEvent: true,
          },
        }],
      }, {
        id: "noop-explore-complete",
        when: {
          eventType: "noop.explore",
          hasFact: "noop explore completed one planned task intent",
          intentStatus: "done",
        },
        then: [{ completeRun: { description: "workflow completed after confirmed explore fact" } }],
      }],
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    join(root, "dist", "index.js"),
    "run",
    taskPath,
    "--db",
    dbPath,
    "--max-steps",
    "4",
  ], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }

  const detail = JSON.parse(result.stdout);
  if (detail.project?.status !== "completed") {
    process.stderr.write(`expected completed status, got ${detail.project?.status ?? "missing"}\n`);
    process.exit(1);
  }
  if (detail.project?.worker !== "noop") {
    process.stderr.write(`expected noop worker, got ${detail.project?.worker ?? "missing"}\n`);
    process.exit(1);
  }
  if (!detail.agents?.smokeExplorer?.promptText?.includes("noop explore agent backed by markdown")) {
    process.stderr.write("expected normalized agent prompt text to be stored in project detail\n");
    process.exit(1);
  }
  if (!Array.isArray(detail.workerRuns) || detail.workerRuns.length < 3) {
    process.stderr.write("expected dispatcher to record at least three worker runs\n");
    process.exit(1);
  }
  if (!detail.intents?.some((intent) => intent.agent === "smokeExplorer" && intent.promptText === "workflow intent prompt text")) {
    process.stderr.write("expected workflow-created intent to retain agent and prompt text\n");
    process.exit(1);
  }
  if (!detail.events?.some((event) => event.type === "workflow.rule_fired" && event.data?.ruleId === "noop-explore-complete")) {
    process.stderr.write("expected hasFact/intentStatus workflow rule to fire\n");
    process.exit(1);
  }
  if (!Array.isArray(detail.workflowNodes) || detail.workflowNodes.length === 0) {
    process.stderr.write("expected dispatcher to record workflow graph nodes\n");
    process.exit(1);
  }
  if (!Array.isArray(detail.workflowEdges) || detail.workflowEdges.length === 0) {
    process.stderr.write("expected dispatcher to record workflow graph edges\n");
    process.exit(1);
  }

  const workersResult = spawnSync(process.execPath, [
    join(root, "dist", "index.js"),
    "workers",
  ], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
  });
  if (workersResult.status !== 0) {
    process.stderr.write(workersResult.stderr || workersResult.stdout);
    process.exit(workersResult.status ?? 1);
  }
  const workers = JSON.parse(workersResult.stdout);
  if (!workers.workers?.includes("openai") || !workers.modelProviders?.includes("anthropic") || !workers.driverKinds?.includes("model")) {
    process.stderr.write("expected worker registry to expose model adapters and providers\n");
    process.exit(1);
  }

  writeFileSync(badTaskPath, JSON.stringify({
    task: {
      name: "bad-output",
      session: "bad-output-session",
      target: "input",
      goal: "Verify parse failures are observable",
    },
    worker: "bad",
    workers: {
      bad: {
        kind: "command",
        command: process.execPath,
        args: ["-e", "console.log('not json')"],
      },
    },
    agents: {
      planner: {
        extends: "planner",
        worker: "bad",
      },
    },
    workflow: {
      phases: [{ id: "bootstrap", agent: "planner", worker: "bad" }],
    },
  }, null, 2));

  const badResult = spawnSync(process.execPath, [
    join(root, "dist", "index.js"),
    "run",
    badTaskPath,
    "--db",
    badDbPath,
    "--max-steps",
    "1",
  ], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
  });

  if (badResult.status !== 0) {
    process.stderr.write(badResult.stderr || badResult.stdout);
    process.exit(badResult.status ?? 1);
  }
  const badDetail = JSON.parse(badResult.stdout);
  if (!badDetail.events?.some((event) => event.type === "worker.parse_failed")) {
    process.stderr.write("expected invalid worker output to create worker.parse_failed event\n");
    process.exit(1);
  }

  writeFileSync(modelTaskPath, JSON.stringify({
    task: {
      name: "model-worker",
      session: "model-worker-session",
      target: "input",
      goal: "Verify model worker adapter failures are observable",
    },
    worker: "modelMissingKey",
    workers: {
      modelMissingKey: {
        kind: "model",
        provider: "openai",
        apiKeyEnv: "DECX_AGENT_SMOKE_MISSING_KEY",
        model: "gpt-4o-mini",
      },
    },
    agents: {
      planner: {
        extends: "planner",
        worker: "modelMissingKey",
      },
    },
    workflow: {
      phases: [{ id: "bootstrap", agent: "planner", worker: "modelMissingKey" }],
    },
  }, null, 2));

  const modelResult = spawnSync(process.execPath, [
    join(root, "dist", "index.js"),
    "run",
    modelTaskPath,
    "--db",
    modelDbPath,
    "--max-steps",
    "1",
  ], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, DECX_AGENT_SMOKE_MISSING_KEY: "" },
  });
  if (modelResult.status !== 0) {
    process.stderr.write(modelResult.stderr || modelResult.stdout);
    process.exit(modelResult.status ?? 1);
  }
  const modelDetail = JSON.parse(modelResult.stdout);
  if (!modelDetail.events?.some((event) => event.type === "worker.failed" && String(event.data?.stderr ?? "").includes("DECX_AGENT_SMOKE_MISSING_KEY"))) {
    process.stderr.write("expected model adapter failure to be recorded as worker.failed event\n");
    process.exit(1);
  }

  process.stdout.write("decx-agent smoke passed\n");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
