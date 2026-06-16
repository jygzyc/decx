/**
 * Task configuration loader: reads v2 task.json, resolves markdown prompt files,
 * and produces a typed TaskConfig.
 */

import { existsSync, readFileSync, statSync } from "fs";
import * as path from "path";
import { isRecord, positiveInt, safeSessionName, stringArray, stringValue } from "./utils.js";
import type { AgentConfig, AgentPhase, AgentTransport, ReviewerConfig, RoleAutonomy, TaskConfig, TaskDefinition, ToolConfig, ToolKind, WorkerConfig, WorkerKind, WorkflowConfig, WorkflowPhase } from "./types.js";

const PHASE_KEYS: AgentPhase[] = ["bootstrap", "reason", "explore", "review"];
const BUILTIN_WORKERS = ["codex", "claude-code", "opencode", "api", "openai", "anthropic", "openai-compatible"] as const;

export interface LoadedTaskConfig {
  config: TaskConfig;
  configPath: string;
  session: string;
  sessionDir: string;
}

export function loadTaskConfigInput(inputPath: string, sessionOverride?: string): LoadedTaskConfig {
  const configPath = resolveConfigPath(inputPath);
  const sessionDir = path.dirname(configPath);
  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
  if (!isRecord(parsed)) throw new Error("task config must be a JSON object");

  const config = parseTaskConfig(parsed, sessionDir);

  const session = safeSessionName(sessionOverride ?? config.task.session ?? path.basename(sessionDir));
  return { config, configPath, session, sessionDir };
}

function resolveConfigPath(inputPath: string): string {
  if (!existsSync(inputPath)) throw new Error(`task config not found: ${inputPath}`);
  const stat = statSync(inputPath);
  if (stat.isDirectory()) return path.join(inputPath, "task.json");
  return inputPath;
}

function parseTaskConfig(value: Record<string, unknown>, baseDir: string): TaskConfig {
  const task = taskDefinition(value.task);
  const worker = stringValue(value.worker);
  const agents = agentMap(value.agents, baseDir);
  const roles = agentMap(value.roles, baseDir);
  const tools = toolMap(value.tools, baseDir);
  const workflow = workflowConfig(value.workflow, baseDir);
  // Merge both `roles` and `agents` from task.json into the canonical `agents` field.
  // `agents` overrides `roles` when the same key appears in both (agents is the newer name).
  const normalizedAgents = { ...(roles ?? {}), ...(agents ?? {}) };
  return {
    task,
    worker,
    agents: Object.keys(normalizedAgents).length > 0 ? normalizedAgents : undefined,
    roles: undefined,
    tools,
    workers: workerMap(value.workers),
    workflow,
  };
}

function taskDefinition(value: unknown): TaskDefinition {
  if (!isRecord(value)) throw new Error("task config requires task object");
  const target = stringValue(value.target);
  const goal = stringValue(value.goal);
  if (!target) throw new Error("task config requires task.target");
  if (!goal) throw new Error("task config requires task.goal");
  return {
    name: stringValue(value.name),
    session: stringValue(value.session),
    target,
    goal,
    mode: stringValue(value.mode),
  };
}

function agentMap(value: unknown, baseDir: string): Record<string, AgentConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const agents: Record<string, AgentConfig> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    const prompt = stringValue(item.prompt);
    agents[name] = {
      extends: stringValue(item.extends),
      prompt,
      promptText: prompt ? readText(baseDir, prompt) : stringValue(item.promptText),
      instructions: stringValue(item.instructions),
      phase: phaseValue(item.phase),
      worker: stringValue(item.worker),
      capabilities: stringArray(item.capabilities),
      tools: stringArray(item.tools),
      autonomy: roleAutonomy(item.autonomy),
    };
  }
  return Object.keys(agents).length > 0 ? agents : undefined;
}

function toolMap(value: unknown, baseDir: string): Record<string, ToolConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const tools: Record<string, ToolConfig> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    const prompt = stringValue(item.prompt);
    tools[name] = {
      kind: toolKind(item.kind),
      description: stringValue(item.description),
      instructions: stringValue(item.instructions),
      prompt,
      promptText: prompt ? readText(baseDir, prompt) : stringValue(item.promptText),
      command: stringValue(item.command),
      args: stringArray(item.args),
    };
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

function reviewerConfig(value: unknown, baseDir: string): ReviewerConfig | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = stringValue(value.prompt);
  return {
    enabled: value.enabled !== false,
    role: stringValue(value.role),
    worker: stringValue(value.worker),
    everySteps: positiveInt(value.everySteps),
    everySeconds: positiveInt(value.everySeconds),
    prompt,
    promptText: prompt ? readText(baseDir, prompt) : stringValue(value.promptText),
  };
}

function workerMap(value: unknown): Record<string, WorkerConfig> {
  const result: Record<string, WorkerConfig> = {};
  if (!isRecord(value)) return result;
  for (const [worker, config] of Object.entries(value)) {
    if (!isRecord(config)) continue;
    const kind = workerKind(config.kind) ?? defaultWorkerKind(worker);
    if (!kind) continue;
    result[worker] = {
      kind,
      backend: stringValue(config.backend),
      transport: agentTransport(config.transport),
      command: stringValue(config.command),
      args: stringArray(config.args),
      provider: stringValue(config.provider),
      baseUrl: stringValue(config.baseUrl),
      model: stringValue(config.model),
      apiKeyEnv: stringValue(config.apiKeyEnv),
      password: stringValue(config.password),
      maxTokens: positiveInt(config.maxTokens),
      temperature: numberValue(config.temperature),
    };
  }
  return result;
}

function workflowConfig(value: unknown, baseDir: string): WorkflowConfig {
  if (!isRecord(value)) return { phases: defaultPhases(), rules: [] };
  return {
    phases: workflowPhases(value.phases),
    review: reviewerConfig(value.review, baseDir),
    rules: Array.isArray(value.rules) ? value.rules as WorkflowConfig["rules"] : [],
  };
}

function readText(baseDir: string, filePath: string): string {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
  return readFileSync(resolved, "utf-8");
}

function phaseValue(value: unknown): AgentPhase | undefined {
  const phase = stringValue(value);
  return phase === "bootstrap" || phase === "reason" || phase === "explore" || phase === "review" ? phase : undefined;
}

function workflowPhases(value: unknown): WorkflowPhase[] {
  if (!Array.isArray(value)) return defaultPhases();
  const phases = value.flatMap((item): WorkflowPhase[] => {
    if (!isRecord(item)) return [];
    const id = phaseValue(item.id);
    if (!id) return [];
    const agent = stringValue(item.agent) ?? stringValue(item.role);
    return [{ id, agent, role: agent, worker: stringValue(item.worker) }];
  });
  return phases.length > 0 ? phases : defaultPhases();
}

function defaultPhases(): WorkflowPhase[] {
  return PHASE_KEYS.map((id) => ({ id }));
}

function roleAutonomy(value: unknown): RoleAutonomy | undefined {
  if (!isRecord(value)) return undefined;
  return {
    canCreateIntents: booleanValue(value.canCreateIntents),
    canCompleteRun: booleanValue(value.canCompleteRun),
    canFailRun: booleanValue(value.canFailRun),
    canReview: booleanValue(value.canReview),
    maxIntentsPerStep: positiveInt(value.maxIntentsPerStep),
  };
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function workerKind(value: unknown): WorkerKind | undefined {
  const kind = stringValue(value);
  if (kind === "agent" || kind === "api") return kind;
  if (kind === "command") return "agent";
  if (kind === "model") return "api";
  return undefined;
}

function agentTransport(value: unknown): AgentTransport | undefined {
  const t = stringValue(value);
  return t === "subprocess" || t === "http" ? t : undefined;
}

function toolKind(value: unknown): ToolKind | undefined {
  const kind = stringValue(value);
  return kind === "tool" || kind === "skill" ? kind : undefined;
}

function defaultWorkerKind(worker: string): WorkerKind | undefined {
  if (worker === "api" || worker === "openai" || worker === "anthropic" || worker === "openai-compatible") return "api";
  return BUILTIN_WORKERS.includes(worker as typeof BUILTIN_WORKERS[number]) ? "agent" : undefined;
}
