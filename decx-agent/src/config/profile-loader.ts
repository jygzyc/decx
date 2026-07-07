/**
 * Profile loader — normalizes SubagentProfile configuration.
 *
 * Strict profiles-only normalization. No legacy field mapping.
 * Every profile MUST declare runtime, prompt, context, permissions, and output.
 */

import type {
  Permission,
  PromptSpec,
  RuntimeSpec,
  SubagentProfile,
  ContextSpec,
  OutputSpec,
  GraphView,
  OutputContract,
} from "../agent/types.js";
import { BUILTIN_PERMISSIONS } from "../agent/types.js";

type Raw = Record<string, unknown>;

export function normalizeProfile(profileId: string, raw: unknown): SubagentProfile {
  if (!raw || typeof raw !== "object") {
    throw new Error(`profile "${profileId}" is undefined or not an object`);
  }
  const r = raw as Raw;

  const role = str(r.role) ?? profileId;
  const runtime = normalizeRuntime(profileId, r);
  const prompt = normalizePrompt(profileId, r);
  const context = normalizeContext(r);
  const permissions = normalizePermissions(profileId, role);
  const output = normalizeOutput(r);
  const maxActive = num(r.maxActive);
  const intervalSeconds = num(r.intervalSeconds);

  const profile: SubagentProfile = { role, runtime, prompt, context, permissions, output };
  if (maxActive !== undefined) profile.maxActive = maxActive;
  if (intervalSeconds !== undefined) profile.intervalSeconds = intervalSeconds;
  return profile;
}

function normalizeRuntime(profileId: string, r: Raw): RuntimeSpec {
  const runtimeRaw = r.runtime as Raw | undefined;
  const src = runtimeRaw ?? r;
  const worker = str(src.worker);
  if (!worker) {
    throw new Error(`profile "${profileId}" must declare runtime.worker`);
  }
  const spec: RuntimeSpec = { worker };
  const workers = strArr(src.workers);
  if (workers.length > 0) spec.workers = workers;
  const model = str(src.model);
  if (model) spec.model = model;
  const provider = str(src.provider);
  if (provider) spec.provider = provider;
  return spec;
}

function normalizePrompt(profileId: string, r: Raw): PromptSpec {
  const promptRaw = r.prompt;
  if (!promptRaw || typeof promptRaw !== "object" || Array.isArray(promptRaw)) {
    throw new Error(`profile "${profileId}" must declare prompt.file`);
  }
  const p = promptRaw as Raw;
  const file = str(p.file);
  if (!file) {
    throw new Error(`profile "${profileId}" must declare prompt.file`);
  }
  const spec: PromptSpec = { file };
  const rules = strArr(p.rules);
  if (rules.length > 0) spec.rules = rules;
  const knowledge = strArr(p.knowledge);
  if (knowledge.length > 0) spec.knowledge = knowledge;
  const instructions = str(p.instructions);
  if (instructions) spec.instructions = instructions;
  return spec;
}

function normalizeContext(r: Raw): ContextSpec {
  const contextRaw = r.context as Raw | undefined;
  const view = (contextRaw ? str(contextRaw.graphView) : undefined) as GraphView | undefined;
  const spec: ContextSpec = { graphView: view ?? "full" };
  if (contextRaw) {
    const maxFacts = num(contextRaw.maxFacts);
    if (maxFacts !== undefined) spec.maxFacts = maxFacts;
    if (typeof contextRaw.includeDeadEnds === "boolean") spec.includeDeadEnds = contextRaw.includeDeadEnds;
    if (typeof contextRaw.includeProgress === "boolean") spec.includeProgress = contextRaw.includeProgress;
    if (typeof contextRaw.rotateOnContextFull === "boolean") spec.rotateOnContextFull = contextRaw.rotateOnContextFull;
    if (contextRaw.relevanceScope === "chain" || contextRaw.relevanceScope === "all") spec.relevanceScope = contextRaw.relevanceScope;
  }
  return spec;
}

function normalizePermissions(profileId: string, role: string): Permission[] {
  return BUILTIN_PERMISSIONS[role] ?? BUILTIN_PERMISSIONS[profileId] ?? [];
}

function normalizeOutput(r: Raw): OutputSpec {
  const outputRaw = r.output as Raw | undefined;
  const contract = (outputRaw ? str(outputRaw.contract) : undefined) as OutputContract | undefined;
  return { contract: contract ?? "candidate_fact" };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}
