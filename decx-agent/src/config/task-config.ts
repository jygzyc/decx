/**
 * task.json loader and merger.
 *
 * Reads a user task file, overlays it on defaultConfig(), validates required
 * task fields, normalizes profiles through ProfileLoader, and returns the
 * normalized TaskConfig plus session metadata. Keep this parser structural;
 * role semantics should live in prompts/config, not code.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { TaskConfig, WorkerConfig, WorkerName, SubagentProfile } from "../agent/types.js";
import { defaultConfig } from "./default-config.js";
import { normalizeProfile } from "./profile-loader.js";

export interface LoadedConfig {
  config: TaskConfig;
  session: string;
  sessionDir: string;
  configPath: string;
}

export function loadConfig(configPath: string, sessionOverride?: string): LoadedConfig {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    throw new Error(`task config not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`task config is not valid JSON: ${(err as Error).message}`);
  }

  if (recordValue(parsed, "agents")) {
    throw new Error("task config uses removed field agents; use profiles instead");
  }

  const base = defaultConfig();
  const config = mergeConfig(base, parsed);

  if (!config.task.target) {
    throw new Error("task.target is required in task config");
  }
  if (!config.task.goal) {
    throw new Error("task.goal is required in task config");
  }

  const session = sessionOverride ?? config.task.session ?? deriveSessionName(absPath);
  const sessionDir = dirname(absPath);

  return { config, session, sessionDir, configPath: absPath };
}

function mergeConfig(base: TaskConfig, override: Record<string, unknown>): TaskConfig {
  const profilesRaw = recordValue(override, "profiles");
  const profiles: Record<string, SubagentProfile> = { ...base.profiles };

  // Always normalize every profile (base defaults included) so the structured
  // shape is guaranteed downstream even when task.json omits a profile.
  const profileIds = new Set<string>([
    "planner", "explorer", "evaluator", "metacog",
    ...(profilesRaw ? Object.keys(profilesRaw) : []),
  ]);
  for (const id of profileIds) {
    const raw = profilesRaw?.[id] ?? base.profiles[id];
    if (raw === undefined) continue;
    profiles[id] = normalizeProfile(id, raw);
  }

  // BuiltinProfiles requires planner/explorer/evaluator keys. Fill any gap
  // from defaults so the structured contract always holds.
  const result: TaskConfig = {
    task: {
      target: stringValue(override, "task.target") ?? base.task.target,
      goal: stringValue(override, "task.goal") ?? base.task.goal,
      session: stringValue(override, "task.session") ?? base.task.session,
      name: stringValue(override, "task.name") ?? base.task.name,
    },
    profiles: {
      ...base.profiles,
      ...profiles,
    } as TaskConfig["profiles"],
    workers: mergeWorkers(base.workers, recordValue(override, "workers")),
    workflow: mergeWorkflow(base.workflow, recordValue(override, "workflow")),
    control: mergeControl(base.control, recordValue(override, "control")),
  };
  return result;
}

function mergeWorkers(
  base: Record<WorkerName, WorkerConfig>,
  override: Record<string, unknown> | undefined,
): Record<WorkerName, WorkerConfig> {
  if (!override) return base;
  const result: Record<WorkerName, WorkerConfig> = { ...base };
  for (const [name, raw] of Object.entries(override)) {
    const w = raw as Record<string, unknown>;
    if (!w) continue;
    result[name] = {
      kind: (stringValue(w, "kind") ?? "agent") as WorkerConfig["kind"],
      backend: stringValue(w, "backend"),
      transport: stringValue(w, "transport") as WorkerConfig["transport"],
      command: stringValue(w, "command"),
      args: Array.isArray(w.args) ? (w.args as string[]) : undefined,
      model: stringValue(w, "model"),
      baseUrl: stringValue(w, "baseUrl"),
      apiKeyEnv: stringValue(w, "apiKeyEnv"),
      password: stringValue(w, "password"),
      provider: stringValue(w, "provider"),
      maxTokens: numberValue(w, "maxTokens"),
      temperature: numberValue(w, "temperature"),
      timeoutMs: numberValue(w, "timeoutMs"),
    };
  }
  return result;
}

function mergeWorkflow(
  base: TaskConfig["workflow"],
  override: Record<string, unknown> | undefined,
): TaskConfig["workflow"] {
  if (!override) return base;
  const limitsRaw = recordValue(override, "limits");
  const metacogRaw = recordValue(override, "metacog");
  const stopGateRaw = recordValue(override, "stopGate");

  return {
    limits: {
      maxSteps: limitsRaw ? numberValue(limitsRaw, "maxSteps") ?? base.limits.maxSteps : base.limits.maxSteps,
      maxConcurrent: limitsRaw ? numberValue(limitsRaw, "maxConcurrent") ?? base.limits.maxConcurrent : base.limits.maxConcurrent,
      refillPerTick: limitsRaw ? numberValue(limitsRaw, "refillPerTick") ?? base.limits.refillPerTick : base.limits.refillPerTick,
      maxStagnation: limitsRaw ? numberValue(limitsRaw, "maxStagnation") ?? base.limits.maxStagnation : base.limits.maxStagnation,
      workerLeaseMs: limitsRaw ? numberValue(limitsRaw, "workerLeaseMs") ?? base.limits.workerLeaseMs : base.limits.workerLeaseMs,
    },
    metacog: metacogRaw ? {
      triggers: {
        everySteps: numberValue(recordValue(metacogRaw, "triggers") ?? {}, "everySteps") ?? base.metacog?.triggers?.everySteps,
        everySeconds: numberValue(recordValue(metacogRaw, "triggers") ?? {}, "everySeconds") ?? base.metacog?.triggers?.everySeconds,
        stagnationLevel: numberValue(recordValue(metacogRaw, "triggers") ?? {}, "stagnationLevel") ?? base.metacog?.triggers?.stagnationLevel,
      },
    } : base.metacog,
    stopGate: stopGateRaw ? {
      requireNoOpenIntents: typeof stopGateRaw.requireNoOpenIntents === "boolean" ? stopGateRaw.requireNoOpenIntents : base.stopGate?.requireNoOpenIntents,
      minFactConfidence: numberValue(stopGateRaw, "minFactConfidence") ?? base.stopGate?.minFactConfidence,
    } : base.stopGate,
  };
}

function mergeControl(
  base: TaskConfig["control"],
  override: Record<string, unknown> | undefined,
): TaskConfig["control"] | undefined {
  if (!override) return base;
  return {
    mainProfile: stringValue(override, "mainProfile") ?? base?.mainProfile,
    metacogProfile: stringValue(override, "metacogProfile") ?? base?.metacogProfile,
    metacogIntervalSeconds: numberValue(override, "metacogIntervalSeconds") ?? base?.metacogIntervalSeconds,
    globalMaxConcurrent: numberValue(override, "globalMaxConcurrent") ?? base?.globalMaxConcurrent,
  };
}

function stringValue(obj: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : undefined;
}

function numberValue(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function recordValue(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function deriveSessionName(configPath: string): string {
  const parts = configPath.replace(/\\/g, "/").split("/");
  const dir = parts[parts.length - 2] ?? "session";
  return dir.replace(/[^a-zA-Z0-9_-]/g, "-");
}
