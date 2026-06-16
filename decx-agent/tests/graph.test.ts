/**
 * Characterization tests for graphBlock() in src/dispatcher/prompt.ts.
 *
 * Exercises the prompt builder and asserts on substrings of the resulting prompt.
 * Tests describe current behavior with the new Fact/Intent/Link graph model.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
// Import from compiled dist/ output because src/ uses NodeNext .js imports
// which Node's --experimental-strip-types cannot resolve at runtime.
// Build (tsc) must have been run before this test executes.
import { buildWorkerPrompt } from "../dist/dispatcher/prompt.js";
import type { ProjectDetail } from "../dist/core/types.js";
import { makeFact, makeIntent, makeLink } from "./helper.ts";

/**
 * Build a minimal ProjectDetail fixture. The graphBlock() section is what
 * we care about, but buildWorkerPrompt also walks project.taskConfig and
 * several other arrays, so we keep the fixture valid end-to-end.
 */
function makeDetail(overrides: {
  facts?: ProjectDetail["facts"];
  intents?: ProjectDetail["intents"];
  links?: ProjectDetail["links"];
} = {}): ProjectDetail {
  const taskConfig = {
    task: { name: "graph-test", target: "t", goal: "g" },
    workers: { noop: { kind: "noop" as const } },
    workflow: {
      phases: [
        { id: "explore" as const, role: "explorer" },
      ],
      rules: [],
    },
  };
  return {
    project: {
      id: "proj_graph_test",
      session: "sess_graph_test",
      name: "graph-test",
      target: "t",
      goal: "g",
      status: "active" as const,
      worker: "noop",
      sessionDir: "/tmp/sess",
      configPath: "/tmp/cfg.json",
      taskConfig,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    facts: overrides.facts ?? [],
    intents: overrides.intents ?? [],
    links: overrides.links ?? [],
    runs: [],
  };
}

/**
 * Extract the graphBlock() slice from the full prompt. The slice starts
 * at "Facts:" and ends at the next blank-line section (i.e. before the
 * "Recent worker runs:" header that follows it).
 */
function graphSection(prompt: string): string {
  const start = prompt.indexOf("Facts:");
  assert.notEqual(start, -1, "expected 'Facts:' section in prompt");
  const end = prompt.indexOf("Recent worker runs:", start);
  if (end === -1) return prompt.slice(start);
  return prompt.slice(start, end);
}

test("graphBlock: empty graph shows '- none' for facts, intents, and links", () => {
  const detail = makeDetail();
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.startsWith("Facts:"), "section should start with 'Facts:'");
  assert.ok(section.includes("- none"), "empty sections should show '- none'");
  assert.match(section, /Facts:\n- none/);
  assert.match(section, /Intents:\n- none/);
  assert.match(section, /Links:\n- none/);
});

test("graphBlock: single fact renders as '- <id>: <description>'", () => {
  const detail = makeDetail({
    facts: [makeFact({ id: "f001", description: "test fact" })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- f001: test fact"));
  assert.match(section, /Intents:\n- none/);
  assert.match(section, /Links:\n- none/);
});

test("graphBlock: fact with confidence < 1.0 renders percentage", () => {
  const detail = makeDetail({
    facts: [makeFact({ id: "f001", description: "uncertain fact", confidence: 0.7 })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- f001 (70%): uncertain fact"), `got: ${section}`);
});

test("graphBlock: fact with confidence 1.0 omits percentage", () => {
  const detail = makeDetail({
    facts: [makeFact({ id: "f001", description: "certain fact", confidence: 1.0 })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- f001: certain fact"));
  assert.ok(!section.includes("(100%)"), "1.0 confidence should not show percentage");
});

test("graphBlock: multiple facts each get their own bullet line", () => {
  const detail = makeDetail({
    facts: [
      makeFact({ id: "f001", description: "first fact" }),
      makeFact({ id: "f002", description: "second fact" }),
      makeFact({ id: "f003", description: "third fact" }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- f001: first fact"));
  assert.ok(section.includes("- f002: second fact"));
  assert.ok(section.includes("- f003: third fact"));
  const idx1 = section.indexOf("- f001:");
  const idx2 = section.indexOf("- f002:");
  const idx3 = section.indexOf("- f003:");
  assert.ok(idx1 < idx2 && idx2 < idx3, "facts should preserve input order");
});

test("graphBlock: intent with status, creator, and fromFacts renders all fields", () => {
  const detail = makeDetail({
    intents: [
      makeIntent({
        id: "i001",
        fromFacts: ["f001", "f002"],
        description: "explore branch",
        creator: "dispatcher",
        status: "done",
      }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(
    section.includes("- i001 [done] role=dispatcher from=f001,f002: explore branch"),
    `expected intent line in section, got: ${section}`,
  );
});

test("graphBlock: intent with empty 'fromFacts' shows 'from=origin'", () => {
  const detail = makeDetail({
    intents: [
      makeIntent({
        id: "i300",
        fromFacts: [],
        description: "starts from origin",
        status: "open",
      }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(
    section.includes("from=origin"),
    `empty 'fromFacts' should render as 'from=origin', got: ${section}`,
  );
});

test("graphBlock: link renders as '- <id>: <from> --<kind>--> <to>'", () => {
  const detail = makeDetail({
    links: [makeLink({ id: "l001", fromFactId: "f001", toFactId: "f002", kind: "enables" })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(
    section.includes("- l001: f001 --enables--> f002"),
    `expected link line, got: ${section}`,
  );
});

test("graphBlock: all three sections appear in fixed Facts/Intents/Links order", () => {
  const detail = makeDetail({
    facts: [makeFact({ id: "fX" })],
    intents: [makeIntent({ id: "iX" })],
    links: [makeLink({ id: "lX" })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  const idxFacts = section.indexOf("Facts:");
  const idxIntents = section.indexOf("Intents:");
  const idxLinks = section.indexOf("Links:");
  assert.ok(idxFacts >= 0 && idxIntents > idxFacts && idxLinks > idxIntents,
    `expected Facts < Intents < Links order, got idxFacts=${idxFacts} idxIntents=${idxIntents} idxLinks=${idxLinks}`);
});

test("graphBlock: status is bracketed and reflects the intent.status field", () => {
  for (const status of ["open", "working", "done", "failed"] as const) {
    const detail = makeDetail({
      intents: [
        makeIntent({ id: `i_${status}`, status, description: `${status} intent` }),
      ],
    });
    const prompt = buildWorkerPrompt({ detail, phase: "explore" });
    const section = graphSection(prompt);
    assert.ok(
      section.includes(`[${status}]`),
      `expected status '${status}' in section, got: ${section}`,
    );
  }
});

test("graphBlock: chain of fact → intent → fact renders all entities independently", () => {
  const detail = makeDetail({
    facts: [
      makeFact({ id: "origin", description: "origin fact" }),
      makeFact({ id: "f001", description: "branch discovered" }),
    ],
    intents: [
      makeIntent({
        id: "i001",
        fromFacts: ["origin"],
        to: "f001",
        status: "done",
        description: "discover branch",
        creator: "tester",
      }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- origin: origin fact"));
  assert.ok(section.includes("- f001: branch discovered"));
  assert.ok(
    section.includes("- i001 [done] role=tester from=origin: discover branch"),
    `expected chain entry, got: ${section}`,
  );
});

test("graphBlock: large graph with many facts/intents/links renders all entries", () => {
  const facts = Array.from({ length: 5 }, (_, i) =>
    makeFact({ id: `f${i + 1}`, description: `fact ${i + 1}` }),
  );
  const intents = Array.from({ length: 4 }, (_, i) =>
    makeIntent({
      id: `i${i + 1}`,
      fromFacts: [`f${i + 1}`],
      description: `intent ${i + 1}`,
      status: i % 2 === 0 ? "open" : "done",
    }),
  );
  const links = Array.from({ length: 3 }, (_, i) =>
    makeLink({ id: `l${i + 1}`, fromFactId: `f${i + 1}`, toFactId: `f${i + 2}`, kind: `kind${i + 1}` }),
  );
  const detail = makeDetail({ facts, intents, links });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);

  for (let i = 1; i <= 5; i++) {
    assert.ok(section.includes(`- f${i}: fact ${i}`), `missing fact f${i}`);
  }
  for (let i = 1; i <= 4; i++) {
    assert.ok(section.includes(`- i${i} [`), `missing intent i${i}`);
  }
  for (let i = 1; i <= 3; i++) {
    assert.ok(section.includes(`- l${i}:`), `missing link l${i}`);
  }
  assert.ok(!section.includes("- none"), "fully populated graph should have no '- none' placeholders");
});
