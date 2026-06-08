import { readFileSync } from "fs";
import * as path from "path";
import type { Fact, Intent, WorkflowEvent, WorkflowRule, WorkflowSeverity } from "../core/types.js";

const SEVERITY_ORDER: Record<WorkflowSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function readWorkflowPrompt(sessionDir: string, promptPath: string | undefined): string | undefined {
  if (!promptPath) return undefined;
  const resolved = path.isAbsolute(promptPath) ? promptPath : path.join(sessionDir, promptPath);
  return readFileSync(resolved, "utf-8");
}

export interface WorkflowMatchContext {
  facts: Fact[];
  intents: Intent[];
}

export function matchesWorkflowRule(rule: WorkflowRule, event: WorkflowEvent, context: WorkflowMatchContext = { facts: [], intents: [] }): boolean {
  const condition = rule.when;
  if (condition.eventType && event.type !== condition.eventType) return false;
  if (condition.minSeverity && SEVERITY_ORDER[event.severity ?? "info"] < SEVERITY_ORDER[condition.minSeverity]) return false;
  if (condition.hasFact && !context.facts.some((fact) => fact.id === condition.hasFact || fact.description.includes(condition.hasFact ?? ""))) return false;
  if (condition.intentStatus) {
    const intent = event.intentId ? context.intents.find((item) => item.id === event.intentId) : undefined;
    if (!intent || intent.status !== condition.intentStatus) return false;
  }
  for (const [key, value] of Object.entries(condition.equals ?? {})) {
    if (eventValue(event, key) !== value) return false;
  }
  for (const [key, value] of Object.entries(condition.includes ?? {})) {
    if (!eventValue(event, key).includes(value)) return false;
  }
  for (const [key, value] of Object.entries(condition.matches ?? {})) {
    if (!new RegExp(value).test(eventValue(event, key))) return false;
  }
  return true;
}

function eventValue(event: WorkflowEvent, key: string): string {
  const direct = event[key as keyof WorkflowEvent];
  if (typeof direct === "string") return direct;
  const data = event.data?.[key];
  return typeof data === "string" ? data : "";
}
