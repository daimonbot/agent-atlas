import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { serve } from "../src/server.mjs";
import * as api from "../src/cursor-api.mjs";
import * as cursor from "../src/providers/cursor.mjs";

// Shape taken from https://cursor.com/docs/account/teams/admin-api (POST /teams/filtered-usage-events).
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/cursor-usage-events.json", import.meta.url), "utf8"));
const KEY = "key_test_0123456789abcdef";

function mockFetch({ status = 200, body = fixture } = {}) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); };
  fn.calls = calls; return fn;
}
function withConfig(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cursor-")), previous = process.env.AGENT_ATLAS_CONFIG_DIR;
    process.env.AGENT_ATLAS_CONFIG_DIR = path.join(dir, "cfg");
    try { await fn(dir); } finally { if (previous === undefined) delete process.env.AGENT_ATLAS_CONFIG_DIR; else process.env.AGENT_ATLAS_CONFIG_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test("token is stored 0600, reported only as set + last 4, and removed with its cache", withConfig(() => {
  assert.deepEqual(api.tokenStatus(), { set: false, last4: null });
  api.saveToken("  " + KEY + "\n");
  assert.equal(fs.statSync(path.join(api.configDir(), "cursor-token")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(api.configDir()).mode & 0o777, 0o700);
  assert.deepEqual(api.tokenStatus(), { set: true, last4: "cdef" });
  assert.equal(JSON.stringify(api.tokenStatus()).includes(KEY), false);
  assert.throws(() => api.saveToken("short"), /does not look like/);
  assert.throws(() => api.saveToken("has space in the key"), /does not look like/);
  fs.writeFileSync(api.eventsPath(), "{}");
  api.removeToken();
  assert.equal(api.readToken(), null); assert.equal(fs.existsSync(api.eventsPath()), false);
}));

test("requests go to api.cursor.com with Basic auth, key as username, and never follow redirects", async () => {
  const fetchImpl = mockFetch();
  const result = await api.testConnection(KEY, fetchImpl);
  assert.equal(result.ok, true);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "https://api.cursor.com/teams/filtered-usage-events");
  assert.equal(call.init.method, "POST"); assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers.authorization, "Basic " + Buffer.from(KEY + ":").toString("base64"));
  assert.equal(JSON.parse(call.init.body).pageSize, 1);
});

test("test connection reports failures without echoing the key", async () => {
  for (const [status, pattern] of [[401, /rejected/], [403, /admin key/], [429, /rate limited/]]) {
    const r = await api.testConnection(KEY, mockFetch({ status, body: { error: KEY } }));
    assert.equal(r.ok, false); assert.equal(r.status, status); assert.match(r.message, pattern); assert.equal(r.message.includes(KEY), false);
  }
  const bad = await api.testConnection(KEY, mockFetch({ body: { nope: 1 } })); assert.equal(bad.ok, false);
  const down = await api.testConnection(KEY, async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); });
  assert.match(down.message, /ENOTFOUND/);
});

test("sync paginates and merges into the cache without duplicates", withConfig(async () => {
  api.saveToken(KEY);
  const pages = [
    { ...fixture, usageEvents: fixture.usageEvents.slice(0, 3), pagination: { hasNextPage: true } },
    { ...fixture, usageEvents: fixture.usageEvents.slice(3), pagination: { hasNextPage: false } },
  ];
  let n = 0; const fetchImpl = async (url, init) => { assert.equal(JSON.parse(init.body).page, n + 1); return new Response(JSON.stringify(pages[n++]), { status: 200 }); };
  const first = await api.syncCursor({ fetchImpl, now: 1790200000000 });
  assert.deepEqual([first.ok, first.fetched, first.cached], [true, 5, 5]);
  assert.equal(fs.statSync(api.eventsPath()).mode & 0o777, 0o600);
  n = 0; const second = await api.syncCursor({ fetchImpl, now: 1790200000000 });
  assert.equal(second.cached, 5);
}));

test("events group by conversationId, else by user with a 30 minute gap", () => {
  const groups = cursor.groupEvents(fixture.usageEvents);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(g => g.events.length).sort(), [1, 2, 2]);
  assert.equal(new Set(groups.map(g => g.id)).size, 3);
  assert.ok(groups.every(g => /^[0-9a-f-]+$/.test(g.id)));
});

test("a cached conversation becomes a tree with Cursor-reported tokens and cost", withConfig(async () => {
  api.saveToken(KEY);
  await api.syncCursor({ fetchImpl: mockFetch(), now: 1790200000000 });
  const refs = cursor.discover(); assert.equal(refs.length, 3);
  const trees = refs.map(ref => cursor.buildTree(ref));
  const convo = trees.find(t => t.model[0] === "claude-4.5-sonnet");
  assert.equal(convo.provider, "cursor"); assert.equal(convo.apiCalls, 2); assert.equal(convo.turns.length, 2);
  assert.deepEqual(convo.tokens, { input: 2000, output: 800, cacheRead: 44000, cacheWrite5m: 4000, cacheWrite1h: 0 });
  assert.equal(convo.cost.total, 0.2); assert.equal(convo.cost.confidence, "reported");
  assert.equal(convo.durationS, 60);
  const mixed = trees.find(t => t.apiCalls === 2 && t !== convo);
  assert.equal(mixed.cost.confidence, "partial"); assert.deepEqual(mixed.unknownModels, ["gpt-5"]);
  assert.equal(mixed.cost.total, 0.01);
}));

test("with no cache there are no Cursor sessions", withConfig(() => { assert.deepEqual(cursor.discover(), []); }));

test("server: save, test, list sessions with provider, status never leaks the key, remove", withConfig(async () => {
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cursor-claude-")), codex = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cursor-codex-"));
  const prev = [process.env.AGENT_ATLAS_CLAUDE_ROOT, process.env.AGENT_ATLAS_CODEX_ROOT];
  process.env.AGENT_ATLAS_CLAUDE_ROOT = claude; process.env.AGENT_ATLAS_CODEX_ROOT = codex;
  const fetchImpl = mockFetch(); const server = serve({ port: 0, intervalS: 1, cursorFetch: fetchImpl }); await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port, host = new URL(base).host;
  const send = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  try {
    const csrf = (await (await fetch(base + "/")).text()).match(/name="atlas-csrf" content="([0-9a-f]+)"/)?.[1]; assert.ok(csrf);
    const good = { origin: "http://" + host, "x-atlas-csrf": csrf };
    assert.equal((await send("PUT", "/api/cursor/token", { token: KEY }, { ...good, origin: "http://evil.example" })).status, 403);
    assert.equal((await send("PUT", "/api/cursor/token", { token: KEY }, { "x-atlas-csrf": csrf })).status, 403, "Origin is required");
    assert.equal((await send("PUT", "/api/cursor/token", { token: KEY }, { origin: good.origin })).status, 403, "CSRF header is required");
    assert.equal((await send("PUT", "/api/cursor/token", { token: KEY }, { ...good, "x-atlas-csrf": "0".repeat(32) })).status, 403);
    assert.equal((await send("PUT", "/api/cursor/token", { token: KEY }, { ...good, "content-type": "text/plain" })).status, 403);
    assert.equal(api.tokenStatus().set, false);
    assert.equal((await send("PUT", "/api/cursor/token", { token: "x" }, good)).status, 400);
    // DNS rebinding: attacker name in Host with a matching Origin and a valid CSRF token still fails, on reads and writes.
    const raw = (method, p, headers, body) => new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port: server.address().port, method, path: p, headers }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); r.on("error", reject); r.end(body); });
    const rebound = "attacker.example:" + server.address().port;
    assert.equal(await raw("PUT", "/api/cursor/token", { host: rebound, origin: "http://" + rebound, "x-atlas-csrf": csrf, "content-type": "application/json" }, JSON.stringify({ token: KEY })), 403);
    assert.equal(await raw("GET", "/api/cursor/status", { host: rebound }), 403);
    assert.equal(await raw("GET", "/api/ui/sessions", { host: rebound }), 403);
    assert.equal(await raw("GET", "/api/cursor/status", { host: "localhost:" + server.address().port }), 200);
    assert.equal(api.tokenStatus().set, false);
    const saved = await send("PUT", "/api/cursor/token", { token: KEY }, good);
    assert.equal(saved.status, 200); const text = await saved.text(); assert.equal(text.includes(KEY), false);
    assert.equal((await (await send("POST", "/api/cursor/test", {}, good)).json()).ok, true);
    let rows = []; const deadline = Date.now() + 8_000;
    while (!rows.length && Date.now() < deadline) { await new Promise(r => setTimeout(r, 100)); rows = (await (await fetch(base + "/api/ui/sessions?usemin=0&from=1970-01-01")).json()).rows.filter(r => r.provider === "cursor"); }
    assert.equal(rows.length, 3);
    const status = await (await fetch(base + "/api/cursor/status")).text(); assert.equal(status.includes(KEY), false);
    assert.equal(JSON.parse(status).last4, "cdef");
    assert.equal((await fetch(base + "/api/cursor/status", { method: "POST" })).status, 403);
    const removed = await (await send("DELETE", "/api/cursor/token", {}, good)).json(); assert.equal(removed.set, false);
    for (const c of fetchImpl.calls) assert.ok(c.url.startsWith("https://api.cursor.com/"));
  } finally {
    server.close(); await once(server, "close"); fs.rmSync(claude, { recursive: true, force: true }); fs.rmSync(codex, { recursive: true, force: true });
    ["AGENT_ATLAS_CLAUDE_ROOT", "AGENT_ATLAS_CODEX_ROOT"].forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
  }
}));

test("the temp file is random, exclusive, 0600, and a planted symlink is never followed", withConfig(() => {
  fs.mkdirSync(api.configDir(), { recursive: true, mode: 0o755 });
  const victim = path.join(path.dirname(api.configDir()), "victim"); fs.writeFileSync(victim, "keep");
  fs.symlinkSync(victim, path.join(api.configDir(), "cursor-token." + process.pid + ".tmp"));
  api.saveToken(KEY);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.equal(fs.statSync(api.configDir()).mode & 0o777, 0o700, "an existing loose dir is tightened");
  assert.equal(fs.statSync(path.join(api.configDir(), "cursor-token")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(api.configDir()).filter(f => f.endsWith(".tmp")), ["cursor-token." + process.pid + ".tmp"]);
}));

test("a sync in flight when the key is removed or replaced does not resurrect or merge the cache", withConfig(async () => {
  api.saveToken(KEY);
  let release; const gate = new Promise(r => { release = r; });
  const slow = async () => { await gate; return new Response(JSON.stringify(fixture), { status: 200 }); };
  const pending = api.syncCursor({ fetchImpl: slow, now: 1790200000000 });
  api.removeToken(); release();
  const result = await pending; assert.equal(result.ok, false); assert.equal(fs.existsSync(api.eventsPath()), false);
  api.saveToken(KEY); assert.equal((await api.syncCursor({ fetchImpl: mockFetch() })).cached, 5);
  api.saveToken("key_other_team_0123456789"); assert.equal(fs.existsSync(api.eventsPath()), false, "another key starts with an empty cache");
  const other = { ...fixture, usageEvents: [fixture.usageEvents[4]] };
  assert.equal((await api.syncCursor({ fetchImpl: mockFetch({ body: other }) })).cached, 1);
}));

test("chargedCents is preferred, totalCents is the fallback, and the basis is recorded", withConfig(async () => {
  api.saveToken(KEY);
  const ev = (ts, extra) => ({ timestamp: String(ts), userEmail: "a@example.com", conversationId: "c-1", model: "m", isTokenBasedCall: true, ...extra });
  const events = [ev(1790000000000, { tokenUsage: { inputTokens: 1, outputTokens: 1, totalCents: 10 }, chargedCents: 4 }),
                  ev(1790000001000, { tokenUsage: { inputTokens: 1, outputTokens: 1, totalCents: 6 } }),
                  ev(1790000002000, { isTokenBasedCall: false, chargedCents: 2 })];
  await api.syncCursor({ fetchImpl: mockFetch({ body: { usageEvents: events, pagination: { hasNextPage: false } } }) });
  const tree = cursor.buildTree(cursor.discover()[0]);
  assert.equal(tree.cost.total, 0.12); assert.equal(tree.costBasis, "mixed"); assert.equal(tree.cost.confidence, "reported");
}));

test("hitting the page cap while more pages remain marks the data truncated everywhere", withConfig(async () => {
  api.saveToken(KEY);
  const more = async () => new Response(JSON.stringify({ ...fixture, pagination: { hasNextPage: true } }), { status: 200 });
  const result = await api.syncCursor({ fetchImpl: more, maxPages: 2 });
  assert.equal(result.ok, true); assert.equal(result.truncated, true);
  const tree = cursor.buildTree(cursor.discover()[0]);
  assert.equal(tree.truncated, true); assert.match(tree.identity?.customTitle ?? tree.agent, /incomplete/);
}));
