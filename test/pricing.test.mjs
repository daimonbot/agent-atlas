import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonical, exactId, candidates } from "../src/pricing/match.mjs";
import { lookup, priceUsage, refresh, resetPricing, pricingRevision, pricingStatus, TTL_MS, RETRY_MS } from "../src/pricing/index.mjs";
import { priceClaude, priceCodex } from "../src/prices.mjs";
import { querySessions, toSessionRow } from "../src/session-index.mjs";
import { buildTree } from "../src/providers/claude.mjs";
import { costLabel, unpricedModels } from "../src/render.mjs";

// Every test runs against a private cache dir and overrides file; the network is
// never touched (refresh gets an injected fetcher).
function sandbox(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pricing-"));
  const saved = { ...process.env };
  Object.assign(process.env, { AGENT_ATLAS_PRICES_CACHE: path.join(dir, "cache.json"),
    AGENT_ATLAS_PRICES_OVERRIDE: path.join(dir, "overrides.json"), AGENT_ATLAS_PRICING: "", ...extra });
  resetPricing();
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); resetPricing(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const entry = (input, output, cacheRead, cw5, cw1h) => ({ input_cost_per_token: input / 1e6, output_cost_per_token: output / 1e6,
  cache_read_input_token_cost: cacheRead == null ? undefined : cacheRead / 1e6, cache_creation_input_token_cost: cw5 == null ? undefined : cw5 / 1e6,
  cache_creation_input_token_cost_above_1hr: cw1h == null ? undefined : cw1h / 1e6, mode: "chat" });
// A catalogue payload large enough to pass the sanity floor.
const litellm = (models = {}) => ({ ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => ["filler-model-" + i, entry(1, 2)])), ...models });
const router = (models = {}) => ({ data: [...Array.from({ length: 60 }, (_, i) => ({ id: "x/filler-" + i, pricing: { prompt: "0.000001", completion: "0.000002" } })),
  ...Object.entries(models).map(([id, pricing]) => ({ id, pricing }))] });
const fetcher = (payloads, log = []) => async url => { log.push(url); const p = payloads[url]; if (p instanceof Error) throw p; return { json: p, version: "sha256:test-" + log.length }; };
const LITE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json", OR = "https://openrouter.ai/api/v1/models";
const U = { in: 1e6, out: 1e6, cr: 1e6, c5: 1e6, c1h: 1e6 };

test("model names from different harnesses meet in one canonical form", () => {
  for (const name of ["claude-opus-5-5", "Claude-Opus-5.5", "anthropic/claude-opus-5.5", "anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5-v1:0",
    "claude-opus-5-5-20260921", "claude-opus-5-5[1m]", "vertex_ai/claude-opus-5-5@default", "bedrock/us-gov-west-1/anthropic.claude-opus-5-5", "openrouter/anthropic/claude-opus-5.5"])
    assert.equal(canonical(name), "claude-opus-5-5", name);
  assert.equal(canonical("gpt-5.6-sol"), "gpt-5-6-sol");
  assert.equal(canonical("openai/gpt-5.6-sol:batch"), "gpt-5-6-sol");
  assert.equal(canonical("gpt-5.5-2026-04-23"), "gpt-5-5");
  assert.equal(exactId("gpt-5.5-2026-04-23"), "gpt-5-5-2026-04-23");
  assert.deepEqual(candidates("anthropic/gpt-4o-2024-05-13"), ["gpt-4o-2024-05-13", "gpt-4o"]);
  assert.equal(canonical("azure/us/gpt-6-astra"), "gpt-6-astra");
  // Distinct models stay distinct: no prefix guessing, no dropping qualifiers.
  assert.notEqual(canonical("claude-opus-5"), canonical("claude-opus-5-5"));
  assert.notEqual(canonical("gpt-5.5-pro"), canonical("gpt-5.5"));
  assert.equal(canonical(""), null); assert.equal(canonical(null), null);
});

test("models that were missing from the old table price from the bundled snapshot with provenance", t => {
  sandbox(t);
  for (const [model, p] of [["claude-opus-5-5", [4, 20, 0.2, 5, 8]], ["claude-fable-5-1", [10, 50, 0.25, 12.5, 20]], ["claude-sonnet-5-5", [2, 10, 0.1, 2.5, 4]], ["claude-opus-5", [5, 25, 0.5, 6.25, 10]]]) {
    const hit = lookup(model);
    assert.deepEqual([hit.p.in, hit.p.out, hit.p.cr, hit.p.cw5, hit.p.cw1h], p, model);
    assert.equal(hit.provenance.source, "litellm"); assert.equal(hit.provenance.origin, "bundled");
    assert.ok(hit.provenance.fetchedAt && hit.provenance.url && hit.provenance.matchedKey);
  }
  const r = priceClaude("claude-opus-5-5", null, U);
  assert.equal(r.usd, 4 + 20 + 0.2 + 5 + 8); assert.equal(r.confidence, "computed");
  assert.deepEqual(r.parts, { in: 4, out: 20, cr: 0.2, cw: 13 });   // cache read and both cache write tiers priced apart
  // Codex harness names resolve through the same path; gpt-5.5 publishes no cache-write price.
  assert.equal(priceCodex("gpt-6-astra", null, { in: 1e6, out: 0, cr: 0, c5: 0, c1h: 0 }).usd, 10);
  assert.equal(lookup("gpt-5.6-sol").p.in, 4);
});

test("a name with provider prefix, date suffix or dots reaches the same price", t => {
  sandbox(t);
  const base = lookup("claude-opus-5-5").p;
  for (const name of ["anthropic/claude-opus-5.5", "claude-opus-5-5-20260921", "us.anthropic.claude-opus-5-5-v1:0"]) assert.deepEqual(lookup(name).p, base, name);
});

test("an unknown model is an explicit unknown state, never a price or a guess", t => {
  sandbox(t);
  const r = priceClaude("claude-opus-9-9", null, U);
  assert.equal(r.confidence, "n/a"); assert.equal(r.unknownModel, "claude-opus-9-9"); assert.equal(r.provenance, null); assert.equal(r.usd, 0);
  assert.equal(lookup("claude-opus-5-9"), null);          // 5-5 exists; no nearest-neighbour pricing
  assert.equal(priceUsage(null, U).unknownModel, "(unattributed)");
});

test("a token class the source does not publish makes the result partial, not silently free", t => {
  sandbox(t);
  const r = priceCodex("gpt-5.5", null, { in: 0, out: 0, cr: 0, c5: 1000, c1h: 0 });   // OpenAI publishes no cache-write rate
  assert.equal(r.confidence, "partial"); assert.deepEqual(r.missingClasses, ["cacheWrite5m"]);
  assert.equal(priceCodex("gpt-5.5", null, { in: 1000, out: 0, cr: 0, c5: 0, c1h: 0 }).confidence, "computed");
});

test("local overrides win over every source and are re-read without a restart", t => {
  const dir = sandbox(t);
  const file = process.env.AGENT_ATLAS_PRICES_OVERRIDE;
  assert.equal(lookup("claude-opus-5-5").provenance.source, "litellm");
  fs.writeFileSync(file, JSON.stringify({ "claude-opus-5-5": { in: 1, out: 2, cr: 0.1, cw5: 1.5 }, "my-private-model": { in: 3, out: 4 } }));
  const hit = lookup("anthropic/claude-opus-5.5");
  assert.deepEqual([hit.p.in, hit.p.out, hit.p.cw1h], [1, 2, null]); assert.equal(hit.provenance.source, "override");
  assert.equal(lookup("my-private-model").p.out, 4);                  // a model no catalogue knows
  fs.writeFileSync(file, "{ not json"); fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(lookup("claude-opus-5-5").provenance.source, "litellm");  // broken file ignored, not fatal
  void dir;
});

test("refresh learns a model that shipped after the release, persists it, and respects the TTL", async t => {
  sandbox(t);
  assert.equal(lookup("claude-opus-7"), null);
  const before = pricingRevision(), log = [];
  const pay = { [LITE]: litellm({ "claude-opus-7": entry(6, 30, 0.6, 7.5, 12), "claude-opus-5-5": entry(4, 20, 0.2, 5, 8) }), [OR]: router() };
  const out = await refresh({ fetchJson: fetcher(pay, log) });
  assert.deepEqual(out.refreshed.sort(), ["litellm", "openrouter"]); assert.deepEqual(out.failed, {});
  const hit = lookup("claude-opus-7");
  assert.deepEqual([hit.p.in, hit.p.out, hit.p.cr, hit.p.cw5, hit.p.cw1h], [6, 30, 0.6, 7.5, 12]);
  assert.equal(hit.provenance.origin, "cache"); assert.equal(hit.provenance.source, "litellm");
  assert.notEqual(pricingRevision(), before);                         // sessions get re-priced
  // Persisted: a new process (simulated) sees it without any network.
  resetPricing(); process.env.AGENT_ATLAS_PRICING = "offline";
  assert.equal(lookup("claude-opus-7").p.in, 6);
  process.env.AGENT_ATLAS_PRICING = "";
  // Within the TTL nothing is fetched again.
  log.length = 0; await refresh({ fetchJson: fetcher(pay, log) }); assert.equal(log.length, 0);
});

test("offline mode never fetches", async t => {
  sandbox(t, { AGENT_ATLAS_PRICING: "offline" });
  const log = []; await refresh({ fetchJson: fetcher({}, log), force: true });
  assert.equal(log.length, 0); assert.equal(pricingStatus().offline, true);
});

test("a down, broken or truncated source keeps the last good catalogue and retries after the back-off", async t => {
  sandbox(t);
  const good = { [LITE]: litellm({ "claude-opus-7": entry(6, 30) }), [OR]: router() };
  await refresh({ fetchJson: fetcher(good) });
  // Down.
  let out = await refresh({ force: true, fetchJson: fetcher({ [LITE]: new Error("ECONNRESET"), [OR]: new Error("HTTP 503") }) });
  assert.match(out.failed.litellm, /ECONNRESET/); assert.equal(lookup("claude-opus-7").p.in, 6);
  // Truncated / redesigned payload is a failed refresh, not an empty price list.
  out = await refresh({ force: true, fetchJson: fetcher({ [LITE]: { "gpt-x": entry(1, 1) }, [OR]: { data: [] } }) });
  assert.match(out.failed.litellm, /only 1 priced models/); assert.equal(lookup("claude-opus-7").p.in, 6);
  assert.equal(lookup("claude-opus-5-5").p.in, 4);       // delisted upstream (absent from the payload) keeps its last price
  // Back-off: after a failure, no retry inside RETRY_MS (even though TTL is long past)...
  const log = []; await refresh({ fetchJson: fetcher(good, log) }); assert.equal(log.length, 0);
  // ...and a retry once it has passed.
  const file = process.env.AGENT_ATLAS_PRICES_CACHE, disk = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const s of Object.values(disk.sources)) s.lastAttempt = new Date(Date.now() - RETRY_MS - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(disk));
  await refresh({ fetchJson: fetcher(good, log) }); assert.equal(log.length, 2);
  assert.ok(TTL_MS > RETRY_MS);
});

test("OpenRouter answers only for models LiteLLM does not know yet", async t => {
  sandbox(t);
  const pay = { [LITE]: litellm({ "claude-opus-5-5": entry(4, 20) }),
    [OR]: router({ "anthropic/claude-opus-5.5": { prompt: "0.000009", completion: "0.00009" },
      "anthropic/claude-newest-1": { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375", input_cache_write_1h: "0.000006" },
      "anthropic/claude-newest-1:batch": { prompt: "0.0000015", completion: "0.0000075" } }) };
  await refresh({ fetchJson: fetcher(pay) });
  assert.equal(lookup("claude-opus-5-5").provenance.source, "litellm"); assert.equal(lookup("claude-opus-5-5").p.in, 4);
  const hit = lookup("claude-newest-1");
  assert.equal(hit.provenance.source, "openrouter"); assert.deepEqual([hit.p.in, hit.p.out, hit.p.cr, hit.p.cw5, hit.p.cw1h], [3, 15, 0.3, 3.75, 6]);  // ":batch" variant ignored
});

test("a session with an unpriced model is flagged and survives the minimum-cost filter", () => {
  const base = { start: "2026-10-20T00:00:00Z", live: false, agents: 0, apiCalls: 1, humanMsgs: 0, tokens: {}, tokenCost: {}, byAgent: {}, title: "t" };
  const rows = [{ ...base, id: "known", project: "p", model: "claude-opus-5-5", cost: 0.1, unpricedModels: [] },
    { ...base, id: "unknown", project: "p", model: "claude-opus-9", cost: 0, unpricedModels: ["claude-opus-9"], costConfidence: "n/a" },
    { ...base, id: "big", project: "p", model: "claude-opus-5-5", cost: 3, unpricedModels: [] }];
  const q = { from: "2026-10-01" };
  const out = querySessions(rows, q);                                  // default minCost 0.5
  assert.deepEqual(out.rows.map(r => r.id).sort(), ["big", "unknown"]); // cheap known hidden, unknown kept
  assert.equal(out.summary.unpriced, 1);
  assert.deepEqual(querySessions(rows, { ...q, usemin: "0" }).rows.length, 3);
});

test("an unknown cost renders as n/a or a lower bound, never $0.00", () => {
  const leaf = (unknown, total) => ({ unknownModels: unknown, children: [], cost: { total } });
  assert.equal(costLabel(leaf(["m"], 0)), "n/a");
  assert.equal(costLabel(leaf(["m"], 1.5)), "≥ $1.50");
  assert.equal(costLabel(leaf([], 1.5)), "$1.50");
  const tree = { unknownModels: [], cost: { total: 2 }, children: [leaf(["gpt-x"], 0)] };
  assert.deepEqual([...unpricedModels(tree)], ["gpt-x"]); assert.equal(costLabel(tree), "≥ $2.00");
});

test("a dated id keeps its own price: the exact id wins over the date-stripped one", async t => {
  sandbox(t);
  // gpt-4o-2024-05-13 was priced $5/$15; the undated gpt-4o (and later snapshots) $2.50/$10.
  const pay = { [LITE]: litellm({ "gpt-4o": entry(2.5, 10), "gpt-4o-2024-05-13": entry(5, 15), "gpt-4o-2024-08-06": entry(2.5, 10) }), [OR]: router() };
  await refresh({ fetchJson: fetcher(pay) });
  assert.deepEqual([lookup("gpt-4o-2024-05-13").p.in, lookup("gpt-4o-2024-05-13").p.out], [5, 15]);
  assert.equal(lookup("openai/gpt-4o-2024-05-13").p.in, 5);          // prefix normalised, still exact
  assert.equal(lookup("gpt-4o").p.in, 2.5);
  assert.equal(lookup("gpt-4o-2031-01-01").p.in, 2.5);               // dated id no source lists: falls back to the undated model
  assert.equal(lookup("gpt-4o-2031-01-01").provenance.matchedKey, "gpt-4o");
  // The exact id is searched in EVERY source before the stripped id is tried in any.
  const pay2 = { [LITE]: litellm({ "acme-1": entry(2.5, 10) }), [OR]: router({ "openai/acme-1-2031-01-01": { prompt: "0.000005", completion: "0.000015" } }) };
  await refresh({ force: true, fetchJson: fetcher(pay2) });
  assert.equal(lookup("acme-1-2031-01-01").p.in, 5); assert.equal(lookup("acme-1-2031-01-01").provenance.source, "openrouter");
  assert.equal(lookup("acme-1-2031-02-02").p.in, 2.5);                 // unlisted date: undated model
});

test("provenance carries the applied rates, currency and an immutable source version", async t => {
  sandbox(t);
  const bundled = lookup("claude-opus-5-5").provenance;
  assert.equal(bundled.currency, "USD"); assert.deepEqual(bundled.rates, { in: 4, out: 20, cr: 0.2, cw5: 5, cw1h: 8 });
  assert.match(bundled.sourceVersion, /^sha256:/);
  await refresh({ fetchJson: fetcher({ [LITE]: litellm({ "claude-opus-7": entry(6, 30) }), [OR]: router() }) });
  const live = lookup("claude-opus-7").provenance;
  assert.match(live.sourceVersion, /^sha256:test-/); assert.equal(live.origin, "cache"); assert.deepEqual(live.rates.in, 6);
  fs.writeFileSync(process.env.AGENT_ATLAS_PRICES_OVERRIDE, JSON.stringify({ "claude-opus-7": { in: 1, out: 2 } }));
  assert.match(lookup("claude-opus-7").provenance.sourceVersion, /^file:/);
});

test("concurrent refreshes never erase entries another process wrote", async t => {
  sandbox(t);
  const good = { [LITE]: litellm({ "model-a": entry(1, 1) }), [OR]: router() };
  const slow = { [LITE]: litellm({ "model-b": entry(2, 2) }), [OR]: router() };
  // Process A reads disk (empty), then is slow; process B fully refreshes meanwhile.
  let release; const gate = new Promise(r => { release = r; });
  const a = refresh({ force: true, fetchJson: async (url) => { await gate; return { json: slow[url], version: "A" }; } });
  await new Promise(r => setTimeout(r, 20));
  await refresh({ force: true, fetchJson: fetcher(good) });
  release(); await a;
  const disk = JSON.parse(fs.readFileSync(process.env.AGENT_ATLAS_PRICES_CACHE, "utf8")).sources.litellm.models;
  assert.ok(disk["model-a"] && disk["model-b"], "both writers' entries survive");
  // A failing refresh after that drops nothing.
  await refresh({ force: true, fetchJson: fetcher({ [LITE]: new Error("down"), [OR]: new Error("down") }) });
  const after = JSON.parse(fs.readFileSync(process.env.AGENT_ATLAS_PRICES_CACHE, "utf8")).sources;
  assert.ok(after.litellm.models["model-a"] && after.litellm.models["model-b"]); assert.equal(after.litellm.error, "down");
  assert.ok(!fs.existsSync(process.env.AGENT_ATLAS_PRICES_CACHE + ".lock"));
});

// A Claude-format transcript for any model name, to drive the whole stack.
function session(t, model, usage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-sess-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "s.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", promptId: "p1", timestamp: "2026-10-20T00:00:00Z", message: { role: "user", content: "hi" } }) + "\n" +
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", promptId: "p1", timestamp: "2026-10-20T00:00:05Z", message: { id: "m1", model, role: "assistant", content: [{ type: "text", text: "ok" }], usage } }) + "\n");
  const ref = { provider: "claude", id: "s", project: "p", path: file, mtimeMs: Date.parse("2026-10-20T00:00:05Z"), size: 1 };
  return toSessionRow(ref, buildTree(ref), Date.now());
}

test("end to end: unknown model and unpublished token class are flagged, kept by the default filter, and per-call confidence is explicit", t => {
  sandbox(t);
  const unknown = session(t, "claude-opus-9-9", { input_tokens: 1000, output_tokens: 1000 });
  assert.equal(unknown.cost, 0); assert.equal(unknown.costConfidence, "n/a"); assert.deepEqual(unknown.unpricedModels, ["claude-opus-9-9"]);
  // GPT-5.5 publishes no cache-write price: cache-write-only usage prices to $0 but is partial.
  const partial = session(t, "gpt-5.5", { cache_creation: { ephemeral_5m_input_tokens: 5000 } });
  assert.equal(partial.cost, 0); assert.equal(partial.costConfidence, "partial");
  assert.match(partial.unpricedModels[0], /gpt-5\.5 \(no cacheWrite5m price\)/);
  const known = session(t, "claude-opus-5-5", { input_tokens: 10, output_tokens: 10 });
  const out = querySessions([unknown, partial, known].map((r, i) => ({ ...r, id: "r" + i })), { from: "2026-10-01" });
  assert.deepEqual(out.rows.map(r => r.id).sort(), ["r0", "r1"]);     // cheap but fully priced r2 is hidden, the two unknowns are not
  assert.equal(out.summary.unpriced, 2);
});

test("overrides invalidate cached session prices before any lookup", t => {
  sandbox(t);
  const before = pricingRevision();
  fs.writeFileSync(process.env.AGENT_ATLAS_PRICES_OVERRIDE, JSON.stringify({ "claude-opus-5-5": { in: 1, out: 2 } }));
  assert.notEqual(pricingRevision(), before);
  assert.equal(lookup("claude-opus-5-5").p.in, 1);
  fs.writeFileSync(process.env.AGENT_ATLAS_PRICES_OVERRIDE, JSON.stringify({ "claude-opus-5-5": { in: -1, out: 2 } }));
  assert.equal(lookup("claude-opus-5-5").provenance.source, "litellm");
});

test("an older refresh finishing last cannot roll back a newer cached price", async t => {
  sandbox(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const older = refresh({ force: true, fetchJson: async url => {
    await gate;
    return { json: url === LITE ? litellm({ "race-model": entry(1, 2) }) : router(), version: "older" };
  } });
  await new Promise(resolve => setTimeout(resolve, 20));
  await refresh({ force: true, fetchJson: fetcher({ [LITE]: litellm({ "race-model": entry(3, 4) }), [OR]: router() }) });
  release(); await older;
  assert.equal(lookup("race-model").p.in, 3);
  resetPricing();
  assert.equal(lookup("race-model").p.in, 3);
});
