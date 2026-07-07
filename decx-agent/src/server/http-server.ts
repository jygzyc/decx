/**
 * HTTP API and dashboard server for decx-agent sessions.
 *
 * Exposes project lists, project details, directives, event streams, and the
 * embedded dashboard HTML. The server is an adapter over Graph state and should
 * not duplicate loopestration policy.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Graph } from "../graph/graph.js";
import type { DirectiveInput, ProjectId } from "../agent/types.js";
import type { SessionLoop } from "../session/session-loop.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function loadDashboard(): string {
  const candidates = [
    join(MODULE_DIR, "dashboard.html"),
    join(MODULE_DIR, "server", "dashboard.html"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(`dashboard.html not found in: ${candidates.join(", ")}`);
}

export interface HttpServerOptions {
  host?: string;
  port?: number;
}

export class HttpServer {
  private server: ReturnType<typeof createServer> | undefined;
  private sseClients = new Map<ProjectId, Set<ServerResponse>>();
  private assignedPort = 0;

  constructor(
    private readonly graph: Graph,
    private readonly sessionLoop?: SessionLoop,
  ) {}

  get port(): number { return this.assignedPort; }

  start(options: HttpServerOptions = {}): Promise<void> {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 25429;

    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.listen(port, host, () => {
        const addr = this.server!.address();
        this.assignedPort = typeof addr === "object" && addr ? addr.port : port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (path === "/" && method === "GET") {
        return this.serveDashboard(res);
      }

      if (path === "/api/projects" && method === "GET") {
        const projects = this.graph.listProjects();
        return this.json(res, projects);
      }

      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && method === "GET") {
        const project = this.graph.getProject(decodeURIComponent(projectMatch[1]));
        if (!project) return this.json(res, { error: "not found" }, 404);
        const facts = this.graph.facts(project.id);
        const intents = this.graph.intents(project.id);
        const hints = this.graph.unconsumedHints(project.id);
        const directives = this.graph.unconsumedDirectives(project.id);
        const links = this.graph.links(project.id);
        const progress = this.graph.progress(project.id);
        return this.json(res, { project, facts, intents, hints, directives, links, progress });
      }

      const directiveMatch = path.match(/^\/api\/projects\/([^/]+)\/directives$/);
      if (directiveMatch && method === "POST") {
        const body = await this.readBody(req);
        const input = JSON.parse(body) as DirectiveInput;
        const projectId = decodeURIComponent(directiveMatch[1]);
        const project = this.graph.getProject(projectId);
        if (!project) return this.json(res, { error: "project not found" }, 404);
        const dir = this.graph.addDirective(project.id, input);
        return this.json(res, dir);
      }

      const streamMatch = path.match(/^\/api\/projects\/([^/]+)\/stream$/);
      if (streamMatch && method === "GET") {
        const projectId = decodeURIComponent(streamMatch[1]);
        return this.handleSSE(projectId, res);
      }

      const eventsMatch = path.match(/^\/api\/projects\/([^/]+)\/events$/);
      if (eventsMatch && method === "GET") {
        const projectId = decodeURIComponent(eventsMatch[1]);
        const project = this.graph.getProject(projectId);
        if (!project) return this.json(res, { error: "not found" }, 404);
        const sinceSeq = url.searchParams.get("since");
        const events = this.graph.events(project.id, sinceSeq ? Number(sinceSeq) : undefined, 500);
        return this.json(res, events);
      }

      this.json(res, { error: "not found", path }, 404);
    } catch (err) {
      this.json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  private serveDashboard(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(loadDashboard());
  }

  private handleSSE(projectId: ProjectId, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");

    let lastSeq = 0;
    const project = this.graph.getProject(projectId);
    if (project) {
      const recent = this.graph.events(project.id, undefined, 10);
      lastSeq = recent.length > 0 ? recent[recent.length - 1].seq : 0;
      for (const ev of recent) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    }

    const pollInterval = setInterval(() => {
      const proj = this.graph.getProject(projectId);
      if (!proj) return;
      const events = this.graph.events(proj.id, lastSeq, 100);
      for (const ev of events) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        lastSeq = ev.seq;
      }
    }, 1000);

    let clients = this.sseClients.get(projectId);
    if (!clients) { clients = new Set(); this.sseClients.set(projectId, clients); }
    clients.add(res);

    const cleanup = (): void => {
      clearInterval(pollInterval);
      clients?.delete(res);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
}
