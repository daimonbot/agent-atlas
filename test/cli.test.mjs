import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("CLI list and tree resolve provider refs and never label unknown usage as free", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cli-pricing-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "claude"), project = path.join(root, "project"), id = "11111111-1111-4111-8111-111111111111";
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, id + ".jsonl"), JSON.stringify({ type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { id: "a1", model: "claude-unknown-99", usage: { input_tokens: 1000, output_tokens: 1000 }, content: [] } }) + "\n");
  const env = { ...process.env, AGENT_ATLAS_CLAUDE_ROOT: root, AGENT_ATLAS_CODEX_ROOT: path.join(dir, "codex"), AGENT_ATLAS_PRICING: "offline", AGENT_ATLAS_PRICES_CACHE: path.join(dir, "prices.json"), AGENT_ATLAS_PRICES_OVERRIDE: path.join(dir, "overrides.json") };
  const cli = (...args) => execFileSync(process.execPath, ["src/cli.mjs", ...args], { env, encoding: "utf8" });
  const rows = JSON.parse(cli("list", "--all", "--json", "--min-cost", "1"));
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].unpricedModels, ["claude-unknown-99"]);
  const tree = JSON.parse(cli("tree", id, "--json"));
  assert.equal(tree.provider, "claude"); assert.equal(tree.cost.confidence, "n/a");
  assert.match(cli("list", "--all"), /total n\/a/);
  assert.match(cli("tree", id), /n\/a/);
});
