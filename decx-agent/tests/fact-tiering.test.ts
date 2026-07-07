import { test } from "node:test";
import { strict as assert } from "node:assert";
import { tierFacts, renderTieredFacts, DEFAULT_TIER_OPTIONS } from "../dist/agent/fact-tiering.js";

function fact(id: string, desc: string, step: number) {
  return {
    id, projectId: "p", description: desc, evidence: [],
    source: "explorer", confidence: 0.9, status: "accepted" as const,
    createdAt: new Date(step * 1000).toISOString(),
    stepDiscovered: step,
  };
}

test("fact-tiering: empty facts returns empty tiers", () => {
  const tiered = tierFacts([], 10);
  assert.equal(tiered.hot.length, 0);
  assert.equal(tiered.warm.length, 0);
});

test("fact-tiering: recent facts go to hot tier", () => {
  const facts = [fact("f001", "recent", 95), fact("f002", "also recent", 96)];
  const tiered = tierFacts(facts, 100, { hotSteps: 10, warmMaxFacts: 20, compressThreshold: 30 });
  assert.equal(tiered.hot.length, 2);
  assert.equal(tiered.warm.length, 0);
});

test("fact-tiering: old facts go to warm tier", () => {
  const facts = [
    fact("f001", "old", 1),
    fact("f002", "old", 2),
    fact("f003", "recent", 95),
  ];
  const tiered = tierFacts(facts, 100, { hotSteps: 10, warmMaxFacts: 20, compressThreshold: 30 });
  assert.equal(tiered.hot.length, 1);
  assert.equal(tiered.warm.length, 2);
});

test("fact-tiering: warm exceeding compressThreshold generates summary", () => {
  const facts: ReturnType<typeof fact>[] = [];
  for (let i = 1; i <= 40; i++) facts.push(fact(`f${i}`, `old fact ${i}`, i));
  facts.push(fact("f41", "recent", 99));

  const tiered = tierFacts(facts, 100, { hotSteps: 10, warmMaxFacts: 10, compressThreshold: 20 });
  assert.ok(tiered.summary);
  assert.match(tiered.summary!, /Findings summary/);
  assert.ok(tiered.warm.length <= 10);
  assert.equal(tiered.hot.length, 1);
});

test("fact-tiering: renderTieredFacts includes summary, warm, and hot sections", () => {
  const tiered = {
    hot: [fact("f099", "hot finding", 99)],
    warm: [fact("f050", "warm finding", 50)],
    cold: [],
    summary: "Findings summary (10 earlier facts): alpha; beta; gamma.",
  };
  const text = renderTieredFacts(tiered);
  assert.match(text, /Earlier Findings/);
  assert.match(text, /Prior Findings/);
  assert.match(text, /Recent Findings/);
  assert.match(text, /hot finding/);
  assert.match(text, /warm finding/);
});

test("fact-tiering: default options have sane values", () => {
  assert.ok(DEFAULT_TIER_OPTIONS.hotSteps > 0);
  assert.ok(DEFAULT_TIER_OPTIONS.warmMaxFacts > 0);
  assert.ok(DEFAULT_TIER_OPTIONS.compressThreshold > DEFAULT_TIER_OPTIONS.warmMaxFacts);
});
