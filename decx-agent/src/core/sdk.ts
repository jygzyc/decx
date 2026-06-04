import type { ArtifactInfo } from "./types.js";
import { existsSync, readdirSync, readFileSync } from "fs";
import * as path from "path";
import { safeSessionName } from "./utils.js";

export interface AgentTaskSessionPaths {
  session: string;
  sessionDir: string;
  taskConfigPath: string;
  promptsDir: string;
  artifactsDir: string;
}

export function scanArtifacts(artifactDir: string): ArtifactInfo[] {
  if (!existsSync(artifactDir)) return [];
  return readdirSync(artifactDir)
    .filter((entry) => entry.endsWith(".xml"))
    .map((entry) => parseArtifactFile(path.join(artifactDir, entry)))
    .filter((entry): entry is ArtifactInfo => entry !== null)
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export function agentTaskSessionPaths(session: string): AgentTaskSessionPaths {
  const safeSession = safeSessionName(session);
  const sessionDir = path.join(AGENT_TASKS_DIR, safeSession);
  return {
    session: safeSession,
    sessionDir,
    taskConfigPath: path.join(sessionDir, "task.json"),
    promptsDir: path.join(sessionDir, "prompts"),
    artifactsDir: path.join(sessionDir, "artifacts"),
  };
}

export function defaultAgentTaskSessionName(task: string, target: string): string {
  return safeSessionName(`${task}-${targetName(target)}-${Date.now()}`);
}

export function resolveAgentTaskConfigPath(inputPath: string): string {
  if (inputPath.endsWith(".json")) return inputPath;
  const direct = path.join(inputPath, "task.json");
  if (existsSync(direct)) return direct;
  return path.join(AGENT_TASKS_DIR, safeSessionName(inputPath), "task.json");
}

const AGENT_TASKS_DIR = path.join(".decx", "agent_tasks");

function parseArtifactFile(filePath: string): ArtifactInfo | null {
  const fileName = path.basename(filePath);
  const chainMatch = /^(h|r)_([^_]+)_([^_]+)_(.+)\.xml$/.exec(fileName);
  if (chainMatch) {
    return {
      path: filePath,
      fileName,
      kind: chainMatch[1] === "r" ? "result" : "handoff",
      scope: "chain",
      sourceId: chainMatch[2],
      sinkId: chainMatch[3],
      flowSig: chainMatch[4],
      decxSession: readXmlTag(filePath, "decxSession") ?? "",
    };
  }
  const sessionMatch = /^h_([^_].*)\.xml$/.exec(fileName);
  if (!sessionMatch) return null;
  return {
    path: filePath,
    fileName,
    kind: "handoff",
    scope: "session",
    sourceId: "",
    sinkId: "",
    flowSig: "session",
    decxSession: readXmlTag(filePath, "decxSession") ?? sessionMatch[1],
  };
}

function readXmlTag(filePath: string, tagName: string): string | null {
  try {
    const xml = readFileSync(filePath, "utf-8");
    const match = new RegExp(`<${tagName}>([^<]*)</${tagName}>`).exec(xml);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function targetName(target: string): string {
  return path.basename(target).replace(/\.[^.]+$/, "") || "target";
}
