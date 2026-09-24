import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionQuery, querySessions } from "../src/session-index.mjs";

const rows = [
  { id: "a", project: "one", model: "m1", title: "alpha", start: "2026-09-20T00:00:00Z", live: true, cost: 4, agents: 2, apiCalls: 7, durationS: 10, agentMs: 1000, humanMsgs: 2, tokens: { in: 1, out: 2, cr: 3, cw: 4 }, tokenCost: { in: 1, out: 1, cr: 1, cw: 1 }, byAgent: { main: { c: 1, o: 4, ms: 1000, t: [1,2,3,4], d: [1,1,1,1] } } },
  { id: "b", project: "two", model: "m2", title: "beta", start: "2026-09-21T00:00:00Z", live: false, cost: 8, agents: 5, apiCalls: 3, durationS: 20, agentMs: 2000, humanMsgs: 1, tokens: { in: 5, out: 6, cr: 7, cw: 8 }, tokenCost: { in: 2, out: 2, cr: 2, cw: 2 }, byAgent: { worker: { c: 2, o: 8, ms: 2000, t: [5,6,7,8], d: [2,2,2,2] } } },
  { id: "c", project: "one", model: "m1", title: "alphabet", start: "2026-09-22T00:00:00Z", live: true, cost: .1, agents: 1, apiCalls: 1, durationS: 30, agentMs: 3000, humanMsgs: 0, tokens: { in: 0, out: 0, cr: 0, cw: 0 }, tokenCost: { in: 0, out: 0, cr: 0, cw: 0 }, byAgent: {} },
];

test("queries aggregate the complete filtered corpus but return one page", () => {
  const result = querySessions(rows, { usemin: "0", sort: "cost", dir: "desc", limit: "1", offset: "1" });
  assert.equal(result.matchedCount, 3); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].id, "a");
  assert.equal(result.summary.cost, 12.1); assert.equal(result.summary.agents, 8); assert.equal(result.breakdown[0].key, "worker");
  assert.equal("path" in result.rows[0], false); assert.equal("byAgent" in result.rows[0], false);
});
test("filters and deterministic sorting use the API query, not the DOM", () => {
  const result = querySessions(rows, { q: "alpha", project: "one", live: "1", usemin: "0", sort: "start", dir: "asc" });
  assert.deepEqual(result.rows.map(row => row.id), ["a", "c"]);
});
test("invalid query values are rejected", () => { assert.throws(() => normalizeSessionQuery({ minCost: "NaN" })); assert.throws(() => normalizeSessionQuery({ from: "not-a-date" })); });


test("agent breakdown retains main remainder and uses seconds for duration", () => {
  const fixture = [{ id: "remainder", project: "one", model: "m1", title: "remainder", start: "2026-09-20T00:00:00Z", live: false, cost: 10, agents: 1, apiCalls: 4, humanMsgs: 2, durationS: 90, agentMs: 60_000, tokens: { in: 100, out: 80, cr: 20, cw: 10 }, tokenCost: { in: 7, out: 2, cr: .5, cw: .5 }, byAgent: { worker: { c: 1, o: 3, ms: 60_000, t: [30, 20, 5, 2], d: [2, 1, .1, .1] } } }];
  const cost = querySessions(fixture, { usemin: "0", by: "agent", metric: "cost" }).breakdown; assert.deepEqual(cost.map(row => [row.key, row.value]), [["main", 7], ["worker", 3]]); assert.equal(cost.find(row => row.key === "main").tokenCost.in, 5);
  const duration = querySessions(fixture, { usemin: "0", by: "agent", metric: "duration" }).breakdown; assert.deepEqual(duration.map(row => [row.key, row.value]), [["main", 90], ["worker", 60]]);
});
