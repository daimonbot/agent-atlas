import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function fixture(t, deferCleanup = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-codex-home-"));
  const home = path.join(dir, "mounted-codex"), empty = path.join(dir, "container-home");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true }); fs.mkdirSync(empty);
  const id = "11111111-1111-4111-8111-111111111111", file = path.join(home, "sessions", "rollout-" + id + ".jsonl"), now = Date.now();
  fs.writeFileSync(file, [
    { type: "turn_context", timestamp: new Date(now).toISOString(), payload: { turn_id: "turn-1", model: "gpt-6.1-sol", effort: "medium" } },
    { type: "token_usage_record", timestamp: new Date(now + 1000).toISOString(), payload: { response_id: "response-1", turn_id: "turn-1", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, total_tokens: 1100 } } },
  ].map(value => JSON.stringify(value) + "\n").join(""));
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, updated_at_ms INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)").run(id, file, "/work/codex-fixture", Math.floor(now / 1000), Math.floor(now / 1000), now);
  // Reproduce a sidecar reading an active WAL store from a read-only mount.
  for (const name of fs.readdirSync(home).filter(name => name.startsWith("state_5.sqlite"))) fs.chmodSync(path.join(home, name), 0o444);
  fs.chmodSync(home, 0o555);
  const cleanup = () => { fs.chmodSync(home, 0o755); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  if (!deferCleanup) t.after(cleanup);
  const env = { ...process.env, HOME: empty, CODEX_HOME: home, AGENT_ATLAS_CODEX_ROOT: "", AGENT_ATLAS_CLAUDE_ROOT: path.join(dir, "empty-claude"), AGENT_ATLAS_PRICING: "offline", AGENT_ATLAS_PRICES_CACHE: path.join(dir, "prices.json"), AGENT_ATLAS_PRICES_OVERRIDE: path.join(dir, "overrides.json"), NODE_NO_WARNINGS: "1" };
  return { id, env, empty, dir, cleanup };
}

test("CODEX_HOME discovers and prices Codex sessions outside the container user's home", t => {
  const { id, env } = fixture(t);
  const rows = JSON.parse(execFileSync(process.execPath, ["src/cli.mjs", "list", "--all", "--json"], { env, encoding: "utf8" }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.ok(rows[0].cost > 0);
  const tree = JSON.parse(execFileSync(process.execPath, ["src/cli.mjs", "tree", id, "--json"], { env, encoding: "utf8" }));
  assert.equal(tree.provider, "codex"); assert.equal(tree.model[0], "gpt-6.1-sol");
  assert.equal(tree.apiCalls, 1); assert.equal(tree.tokens.input, 800); assert.equal(tree.tokens.cacheRead, 200);
  assert.equal(tree.cost.confidence, "computed");
});

test("an explicit Atlas Codex root takes precedence over CODEX_HOME", t => {
  const { env, empty } = fixture(t);
  const rows = JSON.parse(execFileSync(process.execPath, ["src/cli.mjs", "list", "--all", "--json"], { env: { ...env, AGENT_ATLAS_CODEX_ROOT: empty }, encoding: "utf8" }));
  assert.deepEqual(rows, []);
});

test("HTTP index and model filter expose CODEX_HOME sessions from a read-only WAL store", async t => {
  const { id, env, cleanup } = fixture(t, true), saved = { ...process.env };
  Object.assign(process.env, env);
  const { serve } = await import("../src/server.mjs");
  const { once } = await import("node:events");
  const server = serve({ port: 0, intervalS: 60 });
  t.after(async () => { server.close(); await once(server, "close"); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); cleanup(); });
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  let result; const deadline = Date.now() + 5000;
  do {
    result = await (await fetch(origin + "/api/ui/sessions?from=1970-01-01&usemin=0&model=gpt-6.1-sol")).json();
    if (result.indexing.complete) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(result.indexing.error, null); assert.equal(result.indexing.complete, true);
  assert.equal(result.matchedCount, 1); assert.equal(result.rows[0].id, id);
  assert.ok(result.facets.models.includes("gpt-6.1-sol"));
  const detail = await (await fetch(origin + "/api/ui/session/" + id)).json();
  assert.equal(detail.tree.provider, "codex"); assert.ok(detail.tree.cost.total > 0);
});
