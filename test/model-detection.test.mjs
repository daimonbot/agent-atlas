import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function session(t, model, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-model-detection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = "11111111-1111-4111-8111-111111111111", file = path.join(dir, "sessions", id + ".jsonl");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, records.map(record => JSON.stringify(record) + "\n").join(""));
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, updated_at_ms INTEGER, rollout_path TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, model, "/work/model-fixture", 1700000000, 1700000010, 1700000010000, file);
  db.close();
  const env = { ...process.env, AGENT_ATLAS_CODEX_ROOT: dir, AGENT_ATLAS_CLAUDE_ROOT: path.join(dir, "empty-claude"), AGENT_ATLAS_PRICING: "offline", AGENT_ATLAS_PRICES_CACHE: path.join(dir, "prices.json"), AGENT_ATLAS_PRICES_OVERRIDE: path.join(dir, "overrides.json"), NODE_NO_WARNINGS: "1" };
  return JSON.parse(execFileSync(process.execPath, ["src/cli.mjs", "tree", id, "--json"], { encoding: "utf8", env }));
}
const context = (model, turn = "t1") => ({ type: "turn_context", payload: { turn_id: turn, model } });
const usage = (turn = "t1") => ({ type: "token_usage_record", payload: { turn_id: turn, response_id: turn, usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } } });
const settings = model => ({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model } } });

test("a rollout without turn contexts keeps the model declared in thread metadata", t => {
  const tree = session(t, "codex-auto-review", []);
  assert.deepEqual(tree.model, ["codex-auto-review"]);
  assert.equal(tree.modelSource, "thread_metadata");
  assert.equal(tree.cost.confidence, "n/a"); assert.equal(tree.apiCalls, 0);
});

test("recorded thread settings recover a display model when SQLite has none", t => {
  const tree = session(t, null, [settings("gpt-6.1-sol")]);
  assert.deepEqual(tree.model, ["gpt-6.1-sol"]);
  assert.equal(tree.modelSource, "thread_settings"); assert.equal(tree.cost.confidence, "n/a");
});

test("metadata fallback never supplies a missing per-call model for pricing", t => {
  const tree = session(t, "gpt-6.1-sol", [usage()]);
  assert.deepEqual(tree.model, ["gpt-6.1-sol"]);
  assert.equal(tree.calls[0].model, null); assert.equal(tree.cost.confidence, "n/a");
  assert.equal(tree.cost.total, 0); assert.deepEqual(tree.unknownModels, ["(unattributed)"]);
});

test("turn models beat stale thread metadata and preserve model switches", t => {
  const tree = session(t, "gpt-5.5", [context("gpt-6.1-sol"), usage(), context("gpt-6-astra", "t2"), usage("t2")]);
  assert.deepEqual(new Set(tree.model), new Set(["gpt-6.1-sol", "gpt-6-astra"]));
  assert.equal(tree.modelSource, "turn_context");
  assert.deepEqual(tree.calls.map(call => call.model), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.equal(tree.cost.confidence, "computed"); assert.ok(tree.cost.total > 0);
});

test("the model that authored an instruction template is not an executed model", t => {
  const tree = session(t, null, [{ type: "session_meta", payload: { base_instructions: { provenance: { model: "gpt-5.6-terra" } } } }]);
  assert.deepEqual(tree.model, []); assert.equal(tree.modelSource, "unrecorded");
  assert.equal(tree.cost.confidence, "n/a");
});

test("internal and unrecorded models have explanations without changing raw identities", async () => {
  const { modelLabel, modelTooltip } = await import("../src/models.mjs");
  assert.equal(modelLabel("codex-auto-review"), "Codex Auto Review (internal)");
  assert.match(modelTooltip("codex-auto-review"), /permission checks.*Guardian/);
  assert.equal(modelLabel(null), "model not recorded");
  assert.match(modelTooltip(null), /No execution model was recorded/);
  assert.match(modelTooltip("gpt-6.1-sol", "thread_metadata"), /no per-call model/);
  assert.equal(modelLabel("gpt-6.1-sol"), "gpt-6.1-sol");
});

test("missing usage is reported once when no model identity exists", async () => {
  const { unpricedModels } = await import("../src/render.mjs");
  const tree = { model: [], unknownModels: [], children: [], cost: { ownConfidence: "n/a" } };
  assert.deepEqual([...unpricedModels(tree)], ["(usage unavailable)"]);
});

test("Guardian usage retains its real recorded id and is not repriced as the parent model", t => {
  const tree = session(t, "gpt-6.1-sol", [context("codex-auto-review"), usage()]);
  assert.deepEqual(tree.model, ["codex-auto-review"]);
  assert.equal(tree.calls[0].model, "codex-auto-review");
  assert.equal(tree.cost.confidence, "n/a"); assert.equal(tree.cost.total, 0);
  assert.deepEqual(tree.unknownModels, ["codex-auto-review"]);
});
