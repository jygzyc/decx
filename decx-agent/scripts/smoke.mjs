import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(new URL("..", import.meta.url).pathname);
const workspace = mkdtempSync(join(tmpdir(), "decx-agent-smoke-"));
const taskPath = join(workspace, "task.json");
const dbPath = join(workspace, "agent.sqlite");
const promptsDir = join(workspace, "prompts");

try {
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "explorer.md"), "noop explore role backed by markdown");
  writeFileSync(taskPath, JSON.stringify({
    task: {
      name: "smoke",
      session: "smoke-session",
      target: "target.apk",
      goal: "Verify external config execution",
    },
    worker: "noop",
    roles: {
      smokeExplorer: {
        extends: "explorer",
        prompt: "prompts/explorer.md",
        worker: "noop",
        autonomy: {
          canCreateIntents: true,
          maxIntentsPerStep: 1,
        },
      },
    },
    workflow: {
      phases: [
        { id: "bootstrap", role: "planner" },
        { id: "reason", role: "dispatcher" },
        { id: "explore", role: "smokeExplorer" },
        { id: "review", role: "reviewer" },
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
            role: "smokeExplorer",
            fromEvent: true,
          },
        }],
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
  if (!Array.isArray(detail.workerRuns) || detail.workerRuns.length < 4) {
    process.stderr.write("expected dispatcher to record at least four worker runs\n");
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

  process.stdout.write("decx-agent smoke passed\n");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
