#!/usr/bin/env node

/**
 * Command-line interface for decx-agent.
 *
 * Parses user commands for running, resuming, inspecting, serving, and managing
 * agent tasks, then delegates runtime construction to agent-runtime.ts. Keep this
 * file thin so the runtime can be reused by tests and future frontends.
 */

import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "./app/agent-runtime.js";
import { loadConfig } from "./config/task-config.js";
import { InMemoryGraph } from "./graph/in-memory-graph.js";
import { SqliteGraph } from "./graph/sqlite-graph.js";
import { SessionManager } from "./session/session-manager.js";
import { FederatedGraph } from "./graph/federated-graph.js";
import { SessionLoop } from "./session/session-loop.js";
import { HttpServer } from "./server/http-server.js";
import { AgentDriverPool } from "./worker/agent-driver-pool.js";
import { MockWorker } from "./worker/mock-worker.js";
import { workerCapabilities } from "./worker/registry.js";
import { DEFAULT_LIMITS } from "./agent/types.js";
import { defaultConfig } from "./config/default-config.js";

const program = new Command();

program
  .name("decx-agent")
  .description("Generic configured agent runtime")
  .version("0.1.0");

program
  .command("run <configPath>")
  .description("Run a task from a task.json config file")
  .option("-s, --session <session>", "session name override")
  .option("-P, --port <port>", "HTTP server port", "25429")
  .option("--host <host>", "HTTP server host", "127.0.0.1")
  .option("--no-http", "disable HTTP server")
  .option("--no-metacog", "disable metacog loop")
  .option("--mock", "use MockWorker instead of real backends")
  .option("--max-steps <n>", "max steps override", parseInt)
  .action(async (configPath: string, opts: {
    session?: string; port: string; host: string;
    http: boolean; metacog: boolean; mock: boolean; maxSteps?: number;
  }) => {
    const { config, session, sessionDir, configPath: absPath } = loadConfig(configPath, opts.session);
    if (opts.maxSteps) config.workflow.limits.maxSteps = opts.maxSteps;

    const baseDir = sessionDir;
    const workerPool = opts.mock ? new MockWorker() : new AgentDriverPool();

    const runtime = new AgentRuntime(config, {
      baseDir,
      host: opts.host,
      port: parseInt(opts.port),
      workerPool,
      useHttp: opts.http,
      useMetacogSupervisor: opts.metacog,
    });

    const projectId = runtime.createProject({
      session,
      configPath: absPath,
    });

    console.log(`[decx-agent] session: ${session}`);
    console.log(`[decx-agent] project: ${projectId}`);
    console.log(`[decx-agent] target: ${config.task.target}`);
    console.log(`[decx-agent] goal: ${config.task.goal}`);

    if (opts.http) {
      await runtime.startHttp({ host: opts.host, port: parseInt(opts.port) });
      console.log(`[decx-agent] dashboard: http://${opts.host}:${opts.port}`);
    }
    if (opts.metacog) {
      runtime.startMetacog();
      console.log("[decx-agent] metacog loop started (30s interval)");
    }

    console.log("[decx-agent] running...");
    const result = await runtime.run(projectId, { maxSteps: opts.maxSteps ?? config.workflow.limits.maxSteps });
    console.log(`[decx-agent] finished: ${result.type}`);

    if (result.type === "completed") {
      const graph = runtime.graph;
      const facts = graph.facts(projectId, "accepted");
      console.log(`[decx-agent] accepted facts: ${facts.length}`);
      for (const f of facts) {
        console.log(`  ${f.id}: ${f.description}`);
      }
    }

    if (opts.metacog) runtime.stopMetacog();
    if (!opts.http) runtime.close();
  });

program
  .command("resume <session>")
  .description("Resume a stopped/paused session")
  .option("-P, --port <port>", "HTTP server port", "25429")
  .option("--no-http", "disable HTTP server")
  .action(async (session: string, opts: { port: string; http: boolean }) => {
    const sm = new SessionManager(".decx-analysis");
    const info = sm.info(session);
    if (!info.exists) {
      console.error(`session not found: ${session}`);
      process.exit(1);
    }
    const graph = sm.open(session);
    const projects = graph.listProjects();
    if (projects.length === 0) {
      console.error(`no projects in session: ${session}`);
      process.exit(1);
    }
    const project = projects[0];
    graph.updateProjectStatus(project.id, "active");

    const config = project.taskConfig;
    const pool = new AgentDriverPool();
    const loop = new SessionLoop(graph, pool, config);

    let server: HttpServer | undefined;
    if (opts.http) {
      const { HttpServer } = await import("./server/http-server.js");
      server = new HttpServer(graph, loop);
      await server.start({ port: parseInt(opts.port) });
      console.log(`[decx-agent] dashboard: http://127.0.0.1:${opts.port}`);
    }

    console.log(`[decx-agent] resuming project: ${project.id}`);
    const result = await loop.run(project.id);
    console.log(`[decx-agent] finished: ${result.type}`);
    await server?.stop();
  });

program
  .command("status <session>")
  .description("Show project status for a session")
  .action((session: string) => {
    const sm = new SessionManager(".decx-analysis");
    const info = sm.info(session);
    if (!info.exists) {
      console.log(`session not found: ${session}`);
      return;
    }
    const graph = sm.open(session);
    const projects = graph.listProjects();
    for (const p of projects) {
      const progress = graph.progress(p.id);
      console.log(`project: ${p.id}`);
      console.log(`  status: ${p.status}`);
      console.log(`  target: ${p.target}`);
      console.log(`  goal: ${p.goal}`);
      console.log(`  steps: ${progress.stepsExecuted}`);
      console.log(`  accepted: ${progress.acceptedFacts}`);
      console.log(`  candidate: ${progress.candidateFacts}`);
      console.log(`  rejected: ${progress.rejectedFacts}`);
      console.log(`  blocked: ${progress.blockedFacts}`);
      console.log(`  open intents: ${progress.openIntents}`);
    }
  });

program
  .command("workers")
  .description("List available worker backends and providers")
  .action(() => {
    const caps = workerCapabilities();
    console.log(JSON.stringify(caps, null, 2));
  });

program
  .command("sessions")
  .description("List all analysis sessions")
  .option("--base-dir <dir>", "base directory", ".decx-analysis")
  .action((opts: { baseDir: string }) => {
    const sm = new SessionManager(opts.baseDir);
    const sessions = sm.listSessions();
    if (sessions.length === 0) {
      console.log("no sessions found");
      return;
    }
    for (const s of sessions) {
      const info = sm.info(s);
      console.log(`  ${s} (${info.dir})`);
    }
  });

program
  .command("search <query>")
  .description("Search facts across all sessions")
  .option("--base-dir <dir>", "base directory", ".decx-analysis")
  .option("--status <status>", "filter by fact status (accepted/candidate/rejected/blocked)")
  .option("--min-confidence <n>", "minimum confidence", parseFloat)
  .option("--limit <n>", "max results", parseInt, 50)
  .action((query: string, opts: {
    baseDir: string; status?: string; minConfidence?: number; limit: number;
  }) => {
    const sm = new SessionManager(opts.baseDir);
    const fed = new FederatedGraph(sm);
    const sessions = sm.listSessions();
    if (sessions.length === 0) {
      console.log("no sessions found");
      return;
    }
    const results = fed.searchFactsAcrossSessions(sessions, {
      query,
      status: opts.status as "accepted" | "candidate" | "rejected" | "blocked" | undefined,
      minConfidence: opts.minConfidence,
      limit: opts.limit,
    });
    console.log(`found ${results.length} facts matching "${query}":`);
    for (const r of results) {
      console.log(`  [${r.sessionId}] ${r.fact.id} (${r.fact.status}, ${Math.round(r.fact.confidence * 100)}%): ${r.fact.description}`);
    }
  });

program
  .command("init [dir]")
  .description("Create a minimal task.json in the specified directory")
  .action((dir: string = ".") => {
    const config = defaultConfig();
    config.task.target = "example-target";
    config.task.goal = "Describe what you want to analyze";
    const configPath = join(dir, "task.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`created: ${configPath}`);
    console.log("edit target/goal/workers, then run: decx-agent run task.json");
  });

program.parse();
