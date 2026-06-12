/**
 * Characterization tests for graphBlock() in src/dispatcher/prompt.ts.
 *
 * The function is not exported, so we exercise it indirectly through
 * buildWorkerPrompt() and assert on substrings of the resulting prompt.
 *
 * These tests describe the EXISTING behavior. If they fail, the code
 * has drifted from what is recorded here.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
// Import from compiled dist/ output because src/ uses NodeNext .js imports
// which Node's --experimental-strip-types cannot resolve at runtime.
// Build (tsc) must have been run before this test executes.
import { buildWorkerPrompt } from "../dist/dispatcher/prompt.js";
import type { ProjectDetail } from "../dist/server/repository-types.js";
import { makeFact, makeIntent, makeHint } from "./helper.ts";

/**
 * Build a minimal ProjectDetail fixture. The graphBlock() section is what
 * we care about, but buildWorkerPrompt also walks project.taskConfig and
 * several other arrays, so we keep the fixture valid end-to-end.
 */
function makeDetail(overrides: {
  facts?: ProjectDetail["facts"];
  intents?: ProjectDetail["intents"];
  hints?: ProjectDetail["hints"];
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
    agents: {},
    facts: overrides.facts ?? [],
    intents: overrides.intents ?? [],
    hints: overrides.hints ?? [],
    events: [],
    reviews: [],
    workerRuns: [],
    workflowNodes: [],
    workflowEdges: [],
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

test("graphBlock: empty graph shows '- none' for facts, intents, and hints", () => {
  const detail = makeDetail();
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.startsWith("Facts:"), "section should start with 'Facts:'");
  assert.ok(section.includes("- none"), "empty sections should show '- none'");
  // The three headers must each precede a "- none" line.
  assert.match(section, /Facts:\n- none/);
  assert.match(section, /Intents:\n- none/);
  assert.match(section, /Hints:\n- none/);
});

test("graphBlock: single fact renders as '- <id>: <description>'", () => {
  const detail = makeDetail({
    facts: [makeFact({ id: "f001", description: "test fact" })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- f001: test fact"));
  // Intents and hints should still be empty.
  assert.match(section, /Intents:\n- none/);
  assert.match(section, /Hints:\n- none/);
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
  // Order is preserved as the array was passed in.
  const idx1 = section.indexOf("- f001:");
  const idx2 = section.indexOf("- f002:");
  const idx3 = section.indexOf("- f003:");
  assert.ok(idx1 < idx2 && idx2 < idx3, "facts should preserve input order");
});

test("graphBlock: intent with status, agent, and from renders all fields", () => {
  const detail = makeDetail({
    intents: [
      makeIntent({
        id: "i001",
        from: ["f001", "f002"],
        description: "explore branch",
        agent: "explorer",
        status: "done",
      }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(
    section.includes("- i001 [done] agent=explorer from=f001,f002: explore branch"),
    `expected intent line in section, got: ${section}`,
  );
});

test("graphBlock: intent without agent falls back through role to 'explorer'", () => {
  // The fmtIntent helper prefers i.agent, then i.role, then "explorer".
  // With agent omitted but role set, role wins.
  const detailRole = makeDetail({
    intents: [
      makeIntent({
        id: "i100",
        from: ["f1"],
        role: "dispatcher",
        description: "dispatch work",
      }),
    ],
  });
  const promptRole = buildWorkerPrompt({ detail: detailRole, phase: "explore" });
  const sectionRole = graphSection(promptRole);
  assert.ok(
    sectionRole.includes("agent=dispatcher"),
    `role should be used as agent label, got: ${sectionRole}`,
  );

  // With both agent and role omitted, "explorer" is the final fallback.
  // makeIntent defaults role="executor" — we need to override to undefined.
  const intentNoAgent: ProjectDetail["intents"][number] = {
    id: "i200",
    from: ["f1"],
    description: "no agent",
    creator: "tester",
    status: "open",
    createdAt: new Date().toISOString(),
  };
  const detailNone = makeDetail({ intents: [intentNoAgent] });
  const promptNone = buildWorkerPrompt({ detail: detailNone, phase: "explore" });
  const sectionNone = graphSection(promptNone);
  assert.ok(
    sectionNone.includes("agent=explorer"),
    `missing agent and role should default to 'explorer', got: ${sectionNone}`,
  );
});

test("graphBlock: intent with empty 'from' array shows 'from=origin'", () => {
  // makeIntent defaults from=[]. The fmtIntent helper joins with ',' and
  // an empty join yields '' which is falsy, so it falls back to "origin".
  const detail = makeDetail({
    intents: [
      makeIntent({
        id: "i300",
        from: [],
        description: "starts from origin",
        status: "open",
      }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(
    section.includes("from=origin"),
    `empty 'from' should render as 'from=origin', got: ${section}`,
  );
});

test("graphBlock: intent with single 'from' entry shows no comma", () => {
  const detail = makeDetail({
    intents: [
      makeIntent({
        id: "i400",
        from: ["f001"],
        description: "single parent",
        status: "working",
      }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(
    section.includes("from=f001"),
    `single 'from' should not add a trailing comma, got: ${section}`,
  );
  assert.ok(
    !section.includes("from=f001,"),
    `single 'from' should not contain a comma, got: ${section}`,
  );
});

test("graphBlock: hint renders as '- <id>: <content>'", () => {
  const detail = makeDetail({
    hints: [makeHint({ id: "h001", content: "test hint" })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- h001: test hint"));
  // Facts and intents should still be empty.
  assert.match(section, /Facts:\n- none/);
  assert.match(section, /Intents:\n- none/);
});

test("graphBlock: all three sections appear in fixed Facts/Intents/Hints order", () => {
  // Populate every section so the order is unambiguous.
  const detail = makeDetail({
    facts: [makeFact({ id: "fX" })],
    intents: [makeIntent({ id: "iX" })],
    hints: [makeHint({ id: "hX" })],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  const idxFacts = section.indexOf("Facts:");
  const idxIntents = section.indexOf("Intents:");
  const idxHints = section.indexOf("Hints:");
  assert.ok(idxFacts >= 0 && idxIntents > idxFacts && idxHints > idxIntents,
    `expected Facts < Intents < Hints order, got idxFacts=${idxFacts} idxIntents=${idxIntents} idxHints=${idxHints}`);
});

test("graphBlock: status is bracketed and reflects the intent.status field", () => {
  // Each Intent.status value should appear verbatim inside square brackets.
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
  // fact→intent→fact causality is NOT computed by graphBlock; each entity
  // is rendered in its own bullet. makeIntent defaults role="executor" so
  // the fmtIntent fallback chain yields agent=executor.
  const detail = makeDetail({
    facts: [
      makeFact({ id: "origin", description: "origin fact" }),
      makeFact({ id: "f001", description: "branch discovered" }),
    ],
    intents: [
      makeIntent({
        id: "i001",
        from: ["origin"],
        to: "f001",
        status: "done",
        description: "discover branch",
      }),
    ],
  });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);
  assert.ok(section.includes("- origin: origin fact"));
  assert.ok(section.includes("- f001: branch discovered"));
  assert.ok(
    section.includes("- i001 [done] agent=executor from=origin: discover branch"),
    `expected chain entry, got: ${section}`,
  );
});

test("graphBlock: large graph with many facts/intents/hints renders all entries", () => {
  const facts = Array.from({ length: 5 }, (_, i) =>
    makeFact({ id: `f${i + 1}`, description: `fact ${i + 1}` }),
  );
  const intents = Array.from({ length: 4 }, (_, i) =>
    makeIntent({
      id: `i${i + 1}`,
      from: [`f${i + 1}`],
      description: `intent ${i + 1}`,
      status: i % 2 === 0 ? "open" : "done",
    }),
  );
  const hints = Array.from({ length: 3 }, (_, i) =>
    makeHint({ id: `h${i + 1}`, content: `hint ${i + 1}` }),
  );
  const detail = makeDetail({ facts, intents, hints });
  const prompt = buildWorkerPrompt({ detail, phase: "explore" });
  const section = graphSection(prompt);

  // All facts present.
  for (let i = 1; i <= 5; i++) {
    assert.ok(section.includes(`- f${i}: fact ${i}`), `missing fact f${i}`);
  }
  // All intents present.
  for (let i = 1; i <= 4; i++) {
    assert.ok(section.includes(`- i${i} [`), `missing intent i${i}`);
  }
  // All hints present.
  for (let i = 1; i <= 3; i++) {
    assert.ok(section.includes(`- h${i}: hint ${i}`), `missing hint h${i}`);
  }
  // "- none" should NOT appear because no section is empty.
  assert.ok(!section.includes("- none"), "fully populated graph should have no '- none' placeholders");
});
