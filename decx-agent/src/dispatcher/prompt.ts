import type { AgentPhase, Fact, Intent, Link, ProjectDetail, Run, TaskConfig } from "../core/types.js";
import { defaultRoleForPhase, getRole, type RoleDefinition } from "./roles.js";
import { resolveTools, type ToolDefinition } from "../tools/registry.js";

export interface PromptInput {
  detail: ProjectDetail;
  phase: AgentPhase;
  role?: string;
  intent?: Intent;
}

/**
 * Build the full prompt for a worker execution.
 * Sections: capability boundary → project context → role definition → tools → phase instruction → graph state → history → intent → output contract.
 */
export function buildWorkerPrompt(input: PromptInput): string {
  const { detail, phase, intent } = input;
  const roleId = input.role ?? defaultRoleForPhase(phase);
  const role = getRole(detail.project.taskConfig, roleId);
  const tools = resolveTools(detail.project.taskConfig, role.tools);

  return [
    // Capability boundary — what the worker is allowed to do
    role.capabilities?.length
      ? `Allowed capabilities: ${role.capabilities.join(", ")}. Use the worker runtime tools available to you.`
      : "Use the worker runtime tools available to you. Return only the required JSON protocol.",

    // Project context
    [
      `Project: ${detail.project.name}`,
      `Session: ${detail.project.session}`,
      `Target: ${detail.project.target}`,
      `Goal: ${detail.project.goal}`,
    ].join("\n"),

    // Role definition
    [
      `Subagent: ${role.id}`,
      role.extends ? `Extends: ${role.extends}` : "",
      "",
      role.prompt,
    ].filter(Boolean).join("\n"),

    // Tool layer
    toolBlock(tools),

    // Phase-specific instructions
    phaseInstruction(detail.project.taskConfig, phase),

    // Current graph state (facts + intents + links)
    graphBlock(detail.facts, detail.intents, detail.links),

    // Recent history
    workerHistory(detail.runs),

    // Current intent
    intent ? [
      `Current intent: ${intent.id}`,
      intent.role ? `Role: ${intent.role}` : "",
      `Description: ${intent.description}`,
      intent.promptText ? `Intent prompt:\n${intent.promptText}` : "",
    ].filter(Boolean).join("\n") : "",

    // Output contract
    outputContract(phase),
  ].filter(Boolean).join("\n\n");
}

function toolBlock(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "Configured tools: none";
  return [
    "Configured tools:",
    tools.map((tool) => [
      `- ${tool.id} [${tool.kind}]${tool.description ? `: ${tool.description}` : ""}`,
      tool.instructions ? `  Instructions: ${tool.instructions}` : "",
      tool.command ? `  Command: ${[tool.command, ...(tool.args ?? [])].join(" ")}` : "",
    ].filter(Boolean).join("\n")).join("\n"),
  ].join("\n");
}

function phaseInstruction(config: TaskConfig, phase: AgentPhase): string {
  const agent = config.workflow.phases.find((item) => item.id === phase)?.agent
    ?? config.workflow.phases.find((item) => item.id === phase)?.role;
  const text = agent ? `Execute the configured ${phase} phase as subagent ${agent}.` : (
    phase === "bootstrap" ? "Create the initial fact or first exploration intent for this configured task." :
    phase === "reason" ? "Decide if the goal is satisfied. If not, create one to three concrete next intents." :
    phase === "review" ? "Review for drift, weak evidence, repeated work, or premature completion." :
    "Execute the current intent and return one confirmed fact when successful."
  );
  return `Phase instruction: ${text}`;
}

function graphBlock(facts: Fact[], intents: Intent[], links: Link[]): string {
  const fmtIntent = (i: Intent) => {
    const role = i.role ?? i.creator;
    return `- ${i.id} [${i.status}] role=${role} from=${i.fromFacts.join(",") || "origin"}: ${i.description}`;
  };
  const fmtLink = (l: Link) =>
    `- ${l.id}: ${l.fromFactId} --${l.kind}--> ${l.toFactId}`;
  return [
    "Facts:",
    facts.map(f => `- ${f.id}${f.confidence < 1.0 ? ` (${(f.confidence * 100).toFixed(0)}%)` : ""}: ${f.description}`).join("\n") || "- none",
    "",
    "Intents:",
    intents.map(fmtIntent).join("\n") || "- none",
    "",
    "Links:",
    links.map(fmtLink).join("\n") || "- none",
  ].join("\n");
}

function workerHistory(runs: Run[]): string {
  const recent = runs.slice(-5);
  return [
    "Recent worker runs:",
    recent.map(r => `- ${r.phase}/${r.worker} code=${r.returncode} stdout=${JSON.stringify(r.stdoutPreview.slice(0, 160))}`).join("\n") || "- none",
  ].join("\n");
}

function outputContract(phase: AgentPhase): string {
  if (phase === "reason") {
    return [
      'Return {"accepted":true, "data":{"complete":{"from":["f001"],"description":"why done"}}}',
      'or {"accepted":true, "data":{"intents":[{"from":["f001"],"description":"next","role":"explorer"}]}}',
    ].join("\n");
  }
  if (phase === "review") {
    return 'Return {"accepted":true, "data":{"review":{"summary":"...","severity":"info"},"events":[]}} or {"accepted":true, "data":{}}.';
  }
  return [
    'Return {"accepted":true, "data":{"fact":{"description":"...","evidence":[]},"events":[]}}',
    'or {"accepted":true, "data":{"intents":[{"from":["origin"],"description":"next","role":"explorer"}],"events":[]}}',
    'or {"accepted":false, "reason":"why cannot execute"}.',
  ].join("\n");
}
