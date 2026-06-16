import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { AgentRuntime, type RunOptions, type StartRunInput } from "../agent-runtime.js";
import type { WorkerName } from "../core/types.js";
import { positiveInt, stringArray, stringValue } from "../core/utils.js";
import { auditUiHtml } from "./audit-ui.js";
import type { ProjectDetail } from "../core/types.js";
import { knownWorkers } from "../workers/registry.js";

export interface ServeOptions {
  host: string;
  port: number;
  dispatch: boolean;
  intervalMs?: number;
}

export class DecxAgentServer {
  readonly runtime: AgentRuntime;

  constructor(dbPath?: string) {
    this.runtime = new AgentRuntime(dbPath);
  }

  async start(input: StartRunInput, options: RunOptions = {}): Promise<ProjectDetail> {
    return this.runtime.start(input, options);
  }

  async resume(idOrSession: string, options: RunOptions = {}): Promise<ProjectDetail> {
    return this.runtime.resume(idOrSession, options);
  }

  status(idOrSession: string): ProjectDetail {
    return this.runtime.status(idOrSession);
  }

  workers(): ReturnType<AgentRuntime["workers"]> {
    return this.runtime.workers();
  }

  async serve(options: ServeOptions): Promise<void> {
    const httpServer = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port, options.host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    if (options.dispatch) {
      setInterval(() => {
        this.runtime.dispatcher.runActiveOnce().catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
        });
      }, options.intervalMs ?? 2500);
    }
    console.log(`decx-agent listening on http://${options.host}:${options.port}`);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        sendHtml(response, auditUiHtml());
        return;
      }
      if (url.pathname === "/api/projects" && request.method === "GET") {
        sendJson(response, this.runtime.repo.listProjects());
        return;
      }
      if (url.pathname === "/api/projects" && request.method === "POST") {
        const body = await readJson(request);
        const configPath = stringValue(body.configPath);
        if (!configPath) throw new Error("configPath is required");
        sendJson(response, await this.start(
          { configPath, session: stringValue(body.session), worker: stringValue(body.worker) },
          { maxSteps: positiveInt(body.maxSteps) },
        ));
        return;
      }
      const match = /^\/api\/projects\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
      if (match) {
        await this.handleProjectRoute(match.slice(1).filter(Boolean), request, response, url);
        return;
      }
      sendJson(response, { error: { message: "not found" } }, 404);
    } catch (error) {
      sendJson(response, { error: { message: error instanceof Error ? error.message : String(error) } }, 400);
    }
  }

  private async handleProjectRoute(parts: string[], request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const [projectId, segment, intentId, action] = parts;
    if (!segment && request.method === "GET") {
      sendJson(response, this.runtime.repo.getProject(projectId));
      return;
    }
    if (segment === "status" && request.method === "PATCH") {
      const body = await readJson(request);
      const status = stringValue(body.status);
      if (status !== "active" && status !== "stopped" && status !== "completed" && status !== "failed") throw new Error("invalid status");
      this.runtime.repo.updateProjectStatus(this.runtime.repo.getProject(projectId).project.id, status);
      sendJson(response, this.runtime.repo.getProject(projectId));
      return;
    }
    if (segment === "intents" && request.method === "POST" && !intentId) {
      const body = await readJson(request);
      const detail = this.runtime.repo.getProject(projectId);
      const description = requiredString(body.description, "description");
      const from = Array.isArray(body.from) ? body.from.map(String) : ["origin"];
      validateFactIds(detail, from);
      const worker = validateWorker(detail, workerField(body.worker));
      sendJson(response, this.runtime.repo.addIntent(detail.project.id, {
        from,
        description,
        creator: stringValue(body.creator) ?? "human",
        worker,
        priority: positiveInt(body.priority),
      }), 201);
      return;
    }
    if (segment === "intents" && intentId && (action === "claim" || action === "release") && request.method === "POST") {
      const body = await readJson(request);
      const detail = this.runtime.repo.getProject(projectId);
      const worker = validateRequiredWorker(detail, workerField(body.worker) ?? detail.project.worker);
      const intent = action === "claim"
        ? this.runtime.repo.claimIntent(detail.project.id, intentId, worker)
        : this.runtime.repo.releaseIntent(detail.project.id, intentId, worker);
      sendJson(response, intent);
      return;
    }
    if (segment === "intents" && intentId && action === "conclude" && request.method === "POST") {
      const body = await readJson(request);
      const project = this.runtime.repo.getProject(projectId).project;
      const description = requiredString(body.description, "description");
      sendJson(response, this.runtime.repo.concludeIntent(
        project.id,
        intentId,
        description,
        stringArrayField(body.evidence),
        stringValue(body.source) ?? "api",
      ));
      return;
    }
    if (segment === "links" && request.method === "POST") {
      const body = await readJson(request);
      const detail = this.runtime.repo.getProject(projectId);
      const fromFactId = requiredString(body.fromFactId, "fromFactId");
      const toFactId = requiredString(body.toFactId, "toFactId");
      validateFactIds(detail, [fromFactId, toFactId]);
      sendJson(response, this.runtime.repo.addLink(detail.project.id, {
        fromFactId,
        toFactId,
        kind: stringValue(body.kind) ?? "related",
        evidence: stringArrayField(body.evidence),
      }), 201);
      return;
    }
    if (segment === "proof-chain" && request.method === "GET") {
      const factId = url.searchParams.get("factId");
      if (!factId) throw new Error("factId query parameter is required");
      sendJson(response, this.runtime.repo.proofChain(this.runtime.repo.getProject(projectId).project.id, factId));
      return;
    }
    if (segment === "complete" && request.method === "POST") {
      const project = this.runtime.repo.getProject(projectId).project;
      this.runtime.repo.updateProjectStatus(project.id, "completed");
      sendJson(response, this.runtime.repo.getProject(projectId));
      return;
    }
    if (segment === "export" && request.method === "GET") {
      sendText(response, JSON.stringify(this.runtime.repo.getProject(projectId), null, 2));
      return;
    }
    sendJson(response, { error: { message: "not found" } }, 404);
  }
}

function workerField(value: unknown): WorkerName | undefined {
  return stringValue(value);
}

function requiredString(value: unknown, field: string): string {
  const text = stringValue(value)?.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function validateWorker(detail: ProjectDetail, worker: WorkerName | undefined): WorkerName | undefined {
  if (!worker) return undefined;
  if (!knownWorkers(detail.project.taskConfig.workers).includes(worker)) {
    throw new Error(`unsupported worker: ${worker}`);
  }
  return worker;
}

function validateRequiredWorker(detail: ProjectDetail, worker: WorkerName): WorkerName {
  return validateWorker(detail, worker) ?? worker;
}

function validateFactIds(detail: ProjectDetail, factIds: string[]): void {
  const facts = new Set(detail.facts.map((fact) => fact.id));
  for (const id of factIds) {
    if (!facts.has(id)) throw new Error(`fact not found: ${id}`);
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function stringArrayField(value: unknown): string[] {
  return stringArray(value) ?? [];
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function sendText(response: ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end(value);
}

function sendHtml(response: ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(value);
}
