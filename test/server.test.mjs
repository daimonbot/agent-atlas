import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { serve } from "../src/server.mjs";

test("an empty corpus changes from indexing to complete without a row revision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-atlas-empty-")); const previous = process.env.AGENT_ATLAS_CLAUDE_ROOT;
  process.env.AGENT_ATLAS_CLAUDE_ROOT = root; const server = serve({ port: 0, intervalS: 60 }); await once(server, "listening");
  const endpoint = "http://127.0.0.1:" + server.address().port + "/api/ui/sessions?limit=1";
  const first = await (await fetch(endpoint)).json(); assert.equal(first.indexing.complete, false);
  let last = first; const deadline = Date.now() + 3_000;
  while (!last.indexing.complete && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); last = await (await fetch(endpoint)).json(); }
  server.close(); await once(server, "close"); fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.AGENT_ATLAS_CLAUDE_ROOT; else process.env.AGENT_ATLAS_CLAUDE_ROOT = previous;
  assert.equal(last.indexing.complete, true); assert.equal(last.matchedCount, 0); assert.equal(last.revision, 0);
});
