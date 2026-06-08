import type {
  AgentConfig,
  Fact,
  Hint,
  Intent,
  Review,
  TaskConfig,
  WorkerName,
  WorkerRun,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNode,
} from "../core/types.js";

export interface ProjectRecord {
  id: string;
  session: string;
  name: string;
  target: string;
  goal: string;
  status: "active" | "stopped" | "completed" | "failed";
  worker: WorkerName;
  sessionDir: string;
  configPath: string;
  taskConfig: TaskConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  project: ProjectRecord;
  agents: Record<string, AgentConfig>;
  facts: Fact[];
  intents: Intent[];
  hints: Hint[];
  events: WorkflowEvent[];
  reviews: Review[];
  workerRuns: WorkerRun[];
  workflowNodes: WorkflowNode[];
  workflowEdges: WorkflowEdge[];
}
