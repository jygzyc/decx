import type { TaskConfig, ToolConfig, ToolKind } from "../core/types.js";

export interface ToolDefinition {
  id: string;
  kind: ToolKind;
  description?: string;
  instructions?: string;
  command?: string;
  args?: string[];
}

export function resolveTools(config: TaskConfig, toolIds: string[] | undefined): ToolDefinition[] {
  const configured = config.tools ?? {};
  const ids = toolIds && toolIds.length > 0 ? toolIds : Object.keys(configured);
  return ids.flatMap((id) => {
    const tool = configured[id];
    return tool ? [toolDefinition(id, tool)] : [];
  });
}

function toolDefinition(id: string, config: ToolConfig): ToolDefinition {
  return {
    id,
    kind: config.kind ?? "tool",
    description: config.description,
    instructions: config.promptText ?? config.instructions,
    command: config.command,
    args: config.args,
  };
}
