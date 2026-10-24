import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

test("worker publishes changed transcript costs and live local price overrides", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-worker-pricing-"));
  const root = path.join(dir, "claude"), project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const id = "11111111-1111-4111-8111-111111111111", file = path.join(project, id + ".jsonl"), overrides = path.join(dir, "overrides.json");
  const call = id => JSON.stringify({ type: "assistant", uuid: id, timestamp: new Date().toISOString(), message: { id, model: "claude-sonnet-4-6", usage: { input_tokens: 1000000, output_tokens: 0 }, content: [] } }) + "\n";
  fs.writeFileSync(file, call("a1"));
  const worker = new Worker(new URL("../src/index-worker.mjs", import.meta.url), { env: { ...process.env, AGENT_ATLAS_CLAUDE_ROOT: root, AGENT_ATLAS_CODEX_ROOT: path.join(dir, "codex"), AGENT_ATLAS_PRICING: "offline", AGENT_ATLAS_PRICES_CACHE: path.join(dir, "prices.json"), AGENT_ATLAS_PRICES_OVERRIDE: overrides } });
  t.after(async () => { await worker.terminate(); fs.rmSync(dir, { recursive: true, force: true }); });
  let requestId = 0;
  const scan = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker scan timed out")), 5000);
    worker.once("message", response => { clearTimeout(timer); response.ok ? resolve(response.value) : reject(new Error(response.error)); });
    worker.postMessage({ type: "scan", requestId: ++requestId });
  });
  const initial = await scan();
  assert.equal(initial.rows.length, 1);
  assert.ok(initial.rows[0].cost > 0);
  fs.appendFileSync(file, call("a2"));
  const appended = await scan();
  assert.equal(appended.changed, true);
  assert.equal(appended.rows[0].cost, 2 * initial.rows[0].cost);
  fs.writeFileSync(overrides, JSON.stringify({ "claude-sonnet-4-6": { in: 1, out: 2 } }));
  const repriced = await scan();
  assert.equal(repriced.changed, true);
  assert.equal(repriced.rows[0].cost, 2);
  assert.equal((await scan()).changed, false);
});
