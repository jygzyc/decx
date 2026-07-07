import { test } from "node:test";
import { strict as assert } from "node:assert";
import { FederationBus } from "../dist/graph/federation-bus.js";

test("FederationBus: publishInsight + subscribeInsights receives summary", () => {
  const bus = new FederationBus();
  const received: string[] = [];
  bus.subscribeInsights((insight) => received.push(insight.summary));

  bus.publishInsight(
    { sessionId: "s1", projectId: "p1", factId: "f001" },
    "found auth bypass", 0.9,
  );

  assert.equal(received.length, 1);
  assert.equal(received[0], "found auth bypass");
});

test("FederationBus: insightsForSession excludes own session", () => {
  const bus = new FederationBus();
  bus.publishInsight({ sessionId: "s1", projectId: "p1", factId: "f001" }, "from s1", 0.9);
  bus.publishInsight({ sessionId: "s2", projectId: "p2", factId: "f002" }, "from s2", 0.9);

  const forS1 = bus.insightsForSession("s1");
  assert.equal(forS1.length, 1);
  assert.equal(forS1[0].source.sessionId, "s2");
});

test("FederationBus: recentInsights caps at limit", () => {
  const bus = new FederationBus();
  for (let i = 0; i < 10; i++) {
    bus.publishInsight({ sessionId: "s1", projectId: "p1", factId: `f${i}` }, `insight ${i}`, 0.5);
  }
  assert.equal(bus.recentInsights(3).length, 3);
  assert.match(bus.recentInsights(1)[0]!.summary, /insight 9/);
});

test("FederationBus: unsubscribe stops receiving", () => {
  const bus = new FederationBus();
  const received: string[] = [];
  const unsub = bus.subscribeInsights((i) => received.push(i.summary));
  bus.publishInsight({ sessionId: "s1", projectId: "p1", factId: "f1" }, "first", 0.5);
  unsub();
  bus.publishInsight({ sessionId: "s1", projectId: "p1", factId: "f2" }, "second", 0.5);
  assert.equal(received.length, 1);
});
