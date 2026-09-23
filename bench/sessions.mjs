import { performance } from "node:perf_hooks";
import { querySessions } from "../src/session-index.mjs";
const count = Number(process.env.ATLAS_BENCH_SESSIONS || 50_000);
const rows = Array.from({ length: count }, (_, index) => ({ id: "session-" + String(index).padStart(6, "0"), project: "project-" + index % 17, model: index % 3 ? "model-a" : "model-b", title: "synthetic session " + index, start: new Date(Date.UTC(2026, 8, 1 + index % 20)).toISOString(), live: index % 19 === 0, cost: (index % 101) / 10, agents: index % 9, apiCalls: index % 50, durationS: index % 3600, agentMs: index * 100, humanMsgs: index % 5, tokens: { in: index, out: index * 2, cr: index * 3, cw: index * 4 }, tokenCost: { in: 1, out: 2, cr: 3, cw: 4 }, byAgent: {} }));
const started = performance.now();
const result = querySessions(rows, { q: "synthetic", usemin: "0", sort: "cost", dir: "desc", limit: 100, offset: 0 });
const elapsedMs = performance.now() - started;
if (result.rows.length !== 100 || result.matchedCount !== count) throw new Error("unexpected page shape");
console.log(JSON.stringify({ sessions: count, queryMs: +elapsedMs.toFixed(2), matched: result.matchedCount, returnedRows: result.rows.length, serializedPageBytes: Buffer.byteLength(JSON.stringify(result.rows)) }, null, 2));
