import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptLoader } from "../dist/config/prompt-loader.js";
import { normalizeProfile } from "../dist/config/profile-loader.js";

test("PromptLoader: loads prompt.file from disk relative to baseDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-pl-"));
  mkdirSync(join(dir, "prompts"), { recursive: true });
  writeFileSync(join(dir, "prompts", "role.md"), "# Custom Role\nYou are a source finder.");

  const loader = new PromptLoader({ baseDir: dir });
  const resolved = loader.load({ file: "prompts/role.md" });
  assert.equal(resolved.fromConfig, true);
  assert.match(resolved.preamble, /Custom Role/);
});

test("PromptLoader: returns fromConfig=false when file not found", () => {
  const loader = new PromptLoader({ baseDir: "/nonexistent" });
  const resolved = loader.load({ file: "missing.md" });
  assert.equal(resolved.fromConfig, false);
  assert.equal(resolved.preamble, "");
});

test("PromptLoader: appends rules files after primary", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-pl-"));
  writeFileSync(join(dir, "role.md"), "# Role");
  writeFileSync(join(dir, "rule.md"), "RULE: be strict.");

  const loader = new PromptLoader({ baseDir: dir });
  const resolved = loader.load({ file: "role.md", rules: ["rule.md"] });
  assert.match(resolved.preamble, /# Role/);
  assert.match(resolved.preamble, /RULE: be strict/);
});

test("profile-loader: normalizeProfile accepts full structured shape", () => {
  const p = normalizeProfile("source-finder", {
    role: "android-source-finder",
    runtime: { worker: "codex", model: "gpt-5.5" },
    prompt: { file: "prompts/source-finder.md" },
    context: { graphView: "focused", maxFacts: 30 },
    output: { contract: "candidate_fact" },
    maxActive: 2,
  });
  assert.equal(p.role, "android-source-finder");
  assert.equal(p.runtime.model, "gpt-5.5");
  assert.equal(p.context.graphView, "focused");
  assert.equal(p.context.maxFacts, 30);
  assert.equal(p.output.contract, "candidate_fact");
  assert.equal(p.maxActive, 2);
  assert.equal(p.prompt.file, "prompts/source-finder.md");
});

test("profile-loader: throws when runtime.worker missing", () => {
  assert.throws(() => normalizeProfile("x", { prompt: { file: "x.md" } }), /runtime\.worker/);
});

test("profile-loader: throws when prompt.file missing", () => {
  assert.throws(() => normalizeProfile("x", { runtime: { worker: "opencode" } }), /prompt\.file/);
});

test("profile-loader: defaults graphView to full when context omitted", () => {
  const p = normalizeProfile("x", {
    runtime: { worker: "opencode" },
    prompt: { file: "x.md" },
  });
  assert.equal(p.context.graphView, "full");
});

test("profile-loader: fills builtin permissions for planner role", () => {
  const p = normalizeProfile("planner", {
    role: "planner",
    runtime: { worker: "opencode" },
    prompt: { file: "planner.md" },
  });
  assert.ok(p.permissions.includes("create_intent"));
  assert.ok(p.permissions.includes("conclude_run"));
});

test("profile-loader: fills builtin permissions for explorer role", () => {
  const p = normalizeProfile("explorer", {
    role: "explorer",
    runtime: { worker: "opencode" },
    prompt: { file: "explorer.md" },
  });
  assert.ok(p.permissions.includes("write_candidate_fact"));
});
