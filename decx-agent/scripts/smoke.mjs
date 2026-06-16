/**
 * Smoke test: exercises the dispatcher end-to-end with a mock CLI agent.
 *
 * The mock agent is a Node one-liner that emits canned JSON protocol payloads
 * matching the phase it's invoked for — the same behavior the old noop worker
 * provided, but driven through the real AgentDriver subprocess path. This
 * verifies the full command-spawn → stdout-parse → dispatcher-advance loop
 * without depending on any external agent binary.
 */
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

const mockAgentPath = join(workspace, "mock-agent.mjs");
const mockAgentScript = `import { readFileSync } from "node:fs";
const prompt = (() => {
  try { return readFileSync(0, "utf-8"); } catch { return ""; }
})();
if (prompt.includes("configured bootstrap phase")) {
  console.log(JSON.stringify({accepted:true,data:{fact:{description:"mock bootstrap established the initial task target and run graph",evidence:[]},events:[{type:"mock.bootstrap",severity:"info",category:"mock",source:"mock"}]}}));
} else if (prompt.includes("configured reason phase")) {
  if (prompt.includes("mock explore completed one planned task intent")) {
    console.log(JSON.stringify({accepted:true,data:{complete:{from:["f002"],description:"mock run completed after bootstrap, planning, and one exploration step"}}}));
  } else {
    console.log(JSON.stringify({accepted:true,data:{intents:[{from:["f001"],description:"Inspect the task target and produce the first concrete finding candidate"}]}}));
  }
} else if (prompt.includes("configured review phase")) {
  console.log(JSON.stringify({accepted:true,data:{review:{summary:"mock reviewer found no drift",severity:"info"},events:[{type:"review.completed",severity:"info",category:"review",source:"mock"}]}}));
} else {
  console.log(JSON.stringify({accepted:true,data:{fact:{description:"mock explore completed one planned task intent",evidence:[]},events:[{type:"mock.explore",severity:"info",category:"mock",source:"mock"}]}}));
}
`;

try {
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(mockAgentPath, mockAgentScript);
  writeFileSync(join(promptsDir, "explorer.md"), "mock explore agent backed by markdown");
  writeFileSync(taskPath, JSON.stringify({
    task: {
      name: "smoke",
      session: "smoke-session",
      target: "input",
      goal: "Verify external config execution",
    },
    worker: "mockAgent",
    workers: {
      mockAgent: {
        kind: "agent",
        command: process.execPath,
        args: [mockAgentPath],
      },
    },
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
        worker: "mockAgent",
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
        worker: "mockAgent",
        everySteps: 1,
      },
      rules: [{
        id: "mock-bootstrap",
        when: { eventType: "mock.bootstrap" },
        then: [{
          createIntent: {
            description: "workflow-created smoke intent",
            agent: "smokeExplorer",
            promptText: "workflow intent prompt text",
            fromEvent: true,
          },
        }],
      }, {
        id: "mock-explore-complete",
        when: {
          eventType: "mock.explore",
          hasFact: "mock explore completed one planned task intent",
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
  if (detail.project?.worker !== "mockAgent") {
    process.stderr.write(`expected mockAgent worker, got ${detail.project?.worker ?? "missing"}\n`);
    process.exit(1);
  }

  const smokeAgent = detail.project?.taskConfig?.agents?.smokeExplorer;
  if (!smokeAgent?.promptText?.includes("mock explore agent backed by markdown")) {
    process.stderr.write("expected normalized agent prompt text in taskConfig.agents\n");
    process.exit(1);
  }

  if (!Array.isArray(detail.runs) || detail.runs.length < 3) {
    process.stderr.write(`expected at least three runs, got ${detail.runs?.length ?? 0}\n`);
    process.exit(1);
  }

  if (!detail.intents?.some((intent) => intent.role === "smokeExplorer" && intent.promptText === "workflow intent prompt text")) {
    process.stderr.write("expected workflow-created intent to retain role and promptText\n");
    process.exit(1);
  }

  if (!detail.intents?.some((intent) => intent.creator === "workflow" && intent.description === "workflow-created smoke intent")) {
    process.stderr.write("expected workflow-created smoke intent from mock-bootstrap rule\n");
    process.exit(1);
  }

  if (!Array.isArray(detail.facts) || detail.facts.length === 0) {
    process.stderr.write("expected facts to be populated\n");
    process.exit(1);
  }
  if (!Array.isArray(detail.links)) {
    process.stderr.write("expected links array to exist\n");
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
  if (!workers.workers?.includes("api") || !workers.driverKinds?.includes("api")) {
    process.stderr.write("expected worker registry to expose api worker and driver\n");
    process.exit(1);
  }
  if (!workers.modelProviders?.length) {
    process.stderr.write("expected at least one model provider from providers.json/presets\n");
    process.exit(1);
  }
  if (workers.workers?.includes("noop")) {
    process.stderr.write("noop worker should not be registered\n");
    process.exit(1);
  }
  if (!workers.driverKinds?.includes("agent")) {
    process.stderr.write("expected agent driver kind\n");
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
        kind: "agent",
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
  if (!badDetail.runs?.some((run) => run.returncode === 0 && run.stdoutPreview.includes("not json"))) {
    process.stderr.write("expected bad worker output to be recorded in runs\n");
    process.exit(1);
  }

  writeFileSync(modelTaskPath, JSON.stringify({
    task: {
      name: "model-worker",
      session: "model-worker-session",
      target: "input",
      goal: "Verify api worker adapter failures are observable",
    },
    worker: "modelMissingKey",
    workers: {
      modelMissingKey: {
        kind: "api",
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
  if (!modelDetail.runs?.some((run) => run.returncode !== 0 && String(run.stderrPreview ?? "").includes("DECX_AGENT_SMOKE_MISSING_KEY"))) {
    process.stderr.write("expected api adapter failure to be recorded as failed run\n");
    process.exit(1);
  }

  process.stdout.write("decx-agent smoke passed\n");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
