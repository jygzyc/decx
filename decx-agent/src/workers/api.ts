/**
 * API worker: calls OpenAI-compatible or Anthropic chat completion endpoints.
 * Returns the assistant's response text as worker stdout.
 */

import type { WorkerConfig } from "../core/types.js";
import { isRecord } from "../core/utils.js";
import type { WorkerResult } from "./registry.js";

export async function runApiWorker(prompt: string, config: WorkerConfig = { kind: "api" }, worker = "api"): Promise<WorkerResult> {
  const provider = config.provider ?? process.env.DECX_AGENT_API_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai-compatible");
  const apiKeyEnv = config.apiKeyEnv ?? (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
  const key = process.env[apiKeyEnv];
  if (!key) {
    return { worker, returncode: 2, stdout: "", stderr: `api worker requires ${apiKeyEnv}` };
  }

  try {
    const stdout = provider === "anthropic"
      ? await callAnthropic(prompt, config, key)
      : await callOpenAiCompatible(prompt, config, key);
    return { worker, returncode: 0, stdout, stderr: "" };
  } catch (error) {
    return { worker, returncode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function callOpenAiCompatible(prompt: string, config: WorkerConfig, key: string): Promise<string> {
  const response = await fetch(`${trimSlash(config.baseUrl ?? "https://api.openai.com/v1")}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model ?? process.env.DECX_AGENT_API_MODEL ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  return openAiContent(await jsonResponse(response));
}

async function callAnthropic(prompt: string, config: WorkerConfig, key: string): Promise<string> {
  const response = await fetch(`${trimSlash(config.baseUrl ?? "https://api.anthropic.com/v1")}/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model ?? process.env.DECX_AGENT_API_MODEL ?? "claude-3-5-haiku-latest",
      max_tokens: config.maxTokens ?? Number(process.env.DECX_AGENT_API_MAX_TOKENS ?? 4096),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  return anthropicContent(await jsonResponse(response));
}

async function jsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return JSON.parse(text) as unknown;
}

function openAiContent(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.choices)) return "";
  const first = data.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return "";
  return typeof first.message.content === "string" ? first.message.content : "";
}

function anthropicContent(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.content)) return "";
  return data.content.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").join("\n");
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}
