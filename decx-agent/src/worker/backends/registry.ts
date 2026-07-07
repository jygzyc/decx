/**
 * Registry for agent CLI/HTTP backends.
 *
 * Maps backend ids such as opencode, codex, and claude-code to AgentBackend
 * implementations. AgentDriver uses this registry to resolve the low-level
 * runtime for a configured worker.
 */

import type { AgentBackend } from "./types.js";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { OpencodeCliBackend } from "./opencode-cli.js";
import { OpencodeHttpBackend } from "./opencode-http.js";
import { ProcessBackend } from "./process.js";

const REGISTRY = new Map<string, AgentBackend>();

for (const backend of [
  new ClaudeBackend(),
  new CodexBackend(),
  new OpencodeCliBackend(),
  new OpencodeHttpBackend(),
  new ProcessBackend(),
]) {
  REGISTRY.set(backend.id, backend);
}

export function registerAgentBackend(backend: AgentBackend): () => void {
  const previous = REGISTRY.get(backend.id);
  REGISTRY.set(backend.id, backend);
  return () => {
    if (REGISTRY.get(backend.id) === backend) {
      if (previous) REGISTRY.set(backend.id, previous);
      else REGISTRY.delete(backend.id);
    }
  };
}

export function getAgentBackend(id: string): AgentBackend | undefined {
  return REGISTRY.get(id);
}

export function listAgentBackendIds(): string[] {
  return [...REGISTRY.keys()];
}

export { ProcessBackend } from "./process.js";
