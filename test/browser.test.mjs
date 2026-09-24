import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { serve } from "../src/server.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const line = value => JSON.stringify(value) + "\n";
function fixture(root) {
  const project = path.join(root, "-react-fixture"); const session = path.join(project, id + ".jsonl");
  fs.mkdirSync(path.join(project, id, "subagents"), { recursive: true });
  fs.writeFileSync(session, [
    { type: "user", uuid: "user-1", promptId: "prompt-1", timestamp: "2026-01-02T10:00:00.000Z", cwd: "/work/react-fixture", gitBranch: "main", message: { content: "Build the React migration", id: "user-message" } },
    { type: "assistant", uuid: "assistant-1", parentUuid: "user-1", timestamp: "2026-01-02T10:01:00.000Z", cwd: "/work/react-fixture", gitBranch: "main", message: { id: "root-call", model: "claude-sonnet-4-5", usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 50 } }, content: [{ type: "tool_use", id: "task-1", name: "Task", input: { description: "Implement migration" } }] } },
    { type: "assistant", uuid: "assistant-2", parentUuid: "user-1", timestamp: "2026-01-02T10:03:00.000Z", cwd: "/work/react-fixture", gitBranch: "main", message: { id: "root-call-2", model: "claude-sonnet-4-5", usage: { input_tokens: 900, output_tokens: 600, cache_read_input_tokens: 90, cache_creation: { ephemeral_5m_input_tokens: 40 } }, content: [] } }
  ].map(line).join(""));
  fs.writeFileSync(path.join(project, id, "subagents", "agent-child.meta.json"), JSON.stringify({ agentType: "researcher", description: "Design reusable components", toolUseId: "task-1", spawnDepth: 1 }));
  fs.writeFileSync(path.join(project, id, "subagents", "agent-child.jsonl"), [
    { type: "assistant", uuid: "child-1", timestamp: "2026-01-02T10:01:30.000Z", cwd: "/work/react-fixture", message: { id: "child-call", model: "claude-haiku-4-5", usage: { input_tokens: 400, output_tokens: 200, cache_read_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 10 } }, content: [] } }
  ].map(line).join(""));
}
async function complete(endpoint) { let payload; const deadline = Date.now() + 5_000; do { payload = await (await fetch(endpoint)).json(); if (payload.indexing.complete) return payload; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline); throw new Error("index did not finish"); }

test("React UI filters, virtualizes, and navigates through flow, trace and costs", async t => {
  let browser; try { browser = await chromium.launch(); } catch (error) { if (/error while loading shared libraries/.test(error.message)) { t.skip("Chromium runtime unavailable: " + error.message.split("\n")[0]); return; } throw error; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-atlas-browser-")); const previous = process.env.AGENT_ATLAS_CLAUDE_ROOT; fixture(root); process.env.AGENT_ATLAS_CLAUDE_ROOT = root;
  const server = serve({ port: 0, intervalS: 60 }); await once(server, "listening"); const origin = "http://127.0.0.1:" + server.address().port; const indexed = await complete(origin + "/api/ui/sessions?limit=100&from=1970-01-01&usemin=0");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const failures = []; page.on("pageerror", error => failures.push(error.message));
  try {
    await page.goto(origin + "/?r=0&usemin=0", { waitUntil: "networkidle" }); await page.getByRole("navigation", { name: "Session pagination" }).waitFor(); assert.equal(await page.locator(".table-scroll").count(), 0); assert.equal(await page.locator(".sessions-table-region").evaluate(node => getComputedStyle(node).maxHeight), "none"); await page.getByRole("textbox", { name: "Search sessions" }).fill("react-fixture"); await page.waitForTimeout(100);
    assert.match(page.url(), /[?&]q=react-fixture/); await page.locator('a[href="/session/' + id + '"]').click(); await page.waitForURL("**/session/" + id + "**");
    await page.getByRole("button", { name: "Trace" }).click(); await page.locator(".tl-axis .tl-track").dragTo(page.locator(".tl-axis .tl-track"), { sourcePosition: { x: 40, y: 5 }, targetPosition: { x: 260, y: 5 } }); await assert.doesNotReject(() => page.getByRole("button", { name: "reset zoom" }).waitFor());
    await page.getByRole("button", { name: "Costs" }).click(); await page.getByRole("button", { name: "Flow" }).click(); await page.locator("section:not([hidden]) .fw-turns").first().click(); await page.getByRole("dialog", { name: "Calls" }).waitFor(); await page.getByRole("button", { name: "×" }).click();
    assert.ok(await page.locator(".fw-stage").count() >= 1); assert.equal(failures.length, 0, failures.join("\\n")); assert.equal(indexed.rows.length, 1);
  } finally { await browser.close(); server.close(); await once(server, "close"); fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.AGENT_ATLAS_CLAUDE_ROOT; else process.env.AGENT_ATLAS_CLAUDE_ROOT = previous; }
});
