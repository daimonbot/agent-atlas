import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never touch the network or the user's cache from a test.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-atlas-pricing-"));
process.env.AGENT_ATLAS_PRICES_CACHE = path.join(tmp, "prices.json");
process.env.AGENT_ATLAS_PRICING = "offline";
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pricing = await import("../src/pricing/index.mjs");
const { parseAnthropic, parseOpenAI } = await import("../src/pricing/sources.mjs");
const { costLabel } = await import("../src/render.mjs");
const ui = await import("../src/ui/money.ts");

const U = (u = {}) => ({ in: 0, out: 0, cr: 0, cw: 0, c5: 0, c1h: 0, ...u });
const M = 1e6;
const rates = (vendor, model, ts) => {
  const e = pricing.resolve(vendor, model, ts);
  return e && [e.rates.in, e.rates.out, e.rates.cr, e.rates.c5, e.rates.c1h];
};
const resetCache = () => { fs.rmSync(process.env.AGENT_ATLAS_PRICES_CACHE, { force: true }); pricing.reload(); };

// --- Known dated prices, pinned. Source: the official pages as bundled in
// src/pricing/snapshot.json, retrieved 2026-09-29. [in, out, cacheRead, write5m, write1h] $/MTok.
test("bundled snapshot pins Anthropic list prices (retrieved 2026-09-29)", () => {
  resetCache();
  const at = "2026-09-29T12:00:00Z";
  assert.deepEqual(rates("anthropic", "claude-opus-5-5", at), [4, 20, 0.2, 5, 8]);
  assert.deepEqual(rates("anthropic", "claude-opus-5", at), [5, 25, 0.5, 6.25, 10]);
  assert.deepEqual(rates("anthropic", "claude-fable-5-1", at), [10, 50, 0.25, 12.5, 20]);
  assert.deepEqual(rates("anthropic", "claude-fable-5", at), [10, 50, 1, 12.5, 20]);
  assert.deepEqual(rates("anthropic", "claude-sonnet-5-5", at), [2, 10, 0.2, 2.5, 4]);
  assert.deepEqual(rates("anthropic", "claude-sonnet-5", at), [2, 10, 0.2, 2.5, 4]);
  assert.deepEqual(rates("anthropic", "claude-haiku-4-5", at), [1, 5, 0.1, 1.25, 2]);
  assert.deepEqual(rates("anthropic", "claude-opus-4-8", at), [5, 25, 0.5, 6.25, 10]);
});

test("Sonnet 5 stays at $2/$10 after 2026-09-01: the scheduled $3/$15 increase never happened", () => {
  resetCache();
  assert.deepEqual(rates("anthropic", "claude-sonnet-5", "2026-08-15T00:00:00Z"), [2, 10, 0.2, 2.5, 4]);
  assert.deepEqual(rates("anthropic", "claude-sonnet-5", "2026-09-15T00:00:00Z"), [2, 10, 0.2, 2.5, 4]);
});

test("bundled snapshot pins OpenAI (Codex) list prices (retrieved 2026-09-29)", () => {
  resetCache();
  const at = "2026-09-29T12:00:00Z";
  assert.deepEqual(rates("openai", "gpt-6-astra", at), [10, 50, 1, 12.5, 12.5]);
  assert.deepEqual(rates("openai", "gpt-6-sol", at), [2, 10, 0.2, 2.5, 2.5]);
  assert.deepEqual(rates("openai", "gpt-6-luna", at), [0.1, 0.5, 0.01, 0.125, 0.125]);
  assert.deepEqual(rates("openai", "gpt-5.6-sol", at), [4, 20, 0.4, 5, 5]);
  assert.deepEqual(rates("openai", "gpt-5.6-terra", at), [2, 12, 0.2, 2.5, 2.5]);
  assert.deepEqual(rates("openai", "gpt-5.6-luna", at), [0.2, 1.2, 0.02, 0.25, 0.25]);
  // gpt-5.5 publishes no cache-write rate: it stays null, never a guessed 1.25x.
  assert.deepEqual(rates("openai", "gpt-5.5", at), [5, 30, 0.5, null, null]);
});

test("a call is priced per token class with the rates in force, with provenance", () => {
  resetCache();
  const r = pricing.priceUsage("anthropic", "claude-opus-5-5", "2026-09-29T12:00:00Z", U({ in: M, out: M, cr: M, c5: M, c1h: M }));
  assert.equal(r.confidence, "computed");
  assert.deepEqual(r.parts, { in: 4, out: 20, cr: 0.2, cw: 13 });
  assert.equal(r.usd, 37.2);
  const p = pricing.provenance(r.price);
  assert.equal(p.vendor, "anthropic"); assert.equal(p.model, "claude-opus-5-5"); assert.equal(p.currency, "USD");
  assert.equal(p.source.kind, "bundled"); assert.equal(p.source.url, "https://platform.claude.com/docs/en/about-claude/pricing");
  assert.deepEqual(p.rates, { in: 4, out: 20, cr: 0.2, c5: 5, c1h: 8 });
  // Models whose arithmetic was reproduced against the harness's own total keep "verified".
  assert.equal(pricing.priceUsage("anthropic", "claude-opus-5", null, U({ in: 1 })).confidence, "verified");
});

test("decorated transcript ids resolve to the listed model", () => {
  resetCache();
  assert.deepEqual(rates("anthropic", "claude-haiku-4-5-20251001"), [1, 5, 0.1, 1.25, 2]);
  assert.deepEqual(rates("anthropic", "claude-sonnet-5[1m]"), [2, 10, 0.2, 2.5, 4]);
});

test("OpenAI long-context rates apply above 272K input tokens per request", () => {
  resetCache();
  const short = pricing.priceUsage("openai", "gpt-6-astra", null, U({ in: 200_000, cr: 72_000 }));
  const long = pricing.priceUsage("openai", "gpt-6-astra", null, U({ in: 200_000, cr: 72_001 }));
  assert.equal(short.parts.in, 2); assert.equal(long.parts.in, 4);
});

test("a token class with no published rate makes the call partial, not guessed", () => {
  resetCache();
  const r = pricing.priceUsage("openai", "gpt-5.5", null, U({ in: 100_000, c5: 100_000 }));
  assert.equal(r.confidence, "partial"); assert.equal(r.parts.in, 0.5); assert.equal(r.parts.cw, 0);
  assert.match(r.unknownModel, /gpt-5\.5/);
});

// --- The "unknown model is never $0" rule, from the price up to every renderer.
test("an unknown model is unpriced, and renders as n/a, never $0.00", () => {
  resetCache();
  const r = pricing.priceUsage("anthropic", "claude-nonexistent-9", "2026-09-29T00:00:00Z", U({ in: 1000, out: 1000 }));
  assert.equal(r.confidence, "n/a"); assert.equal(r.unknownModel, "claude-nonexistent-9"); assert.equal(r.price, null);
  for (const text of [costLabel(0, "n/a"), ui.costText(0, "n/a"), ui.totalText({ cost: { total: 0, confidence: "n/a" } }),
    ui.ownText({ cost: { own: 0, ownConfidence: "n/a" } }), ui.sumText([{ cost: { total: 0, confidence: "n/a" } }])]) {
    assert.equal(text, "n/a"); assert.doesNotMatch(text, /\$0\.00/);
  }
  assert.equal(ui.costText(3.5, "partial"), "≥ $3.50");
  assert.equal(ui.sumText([{ cost: { total: 2, confidence: "computed" } }, { cost: { total: 0, confidence: "n/a" } }]), "≥ $2.00");
});

test("a session on an unknown model builds as n/a, and is not hidden by the min-cost filter", async () => {
  resetCache();
  const root = fs.mkdtempSync(path.join(tmp, "claude-")), codexRoot = fs.mkdtempSync(path.join(tmp, "codex-"));
  const project = path.join(root, "-fixture"); fs.mkdirSync(project);
  const line = (id, model, ts) => JSON.stringify({ type: "assistant", uuid: "u-" + id, timestamp: ts,
    message: { id, model, usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0 }, content: [] } }) + "\n";
  fs.writeFileSync(path.join(project, "aaaaaaaa-0000-4000-8000-000000000001.jsonl"), line("m1", "claude-unreleased-9", "2026-09-29T10:00:00.000Z"));
  fs.writeFileSync(path.join(project, "aaaaaaaa-0000-4000-8000-000000000002.jsonl"),
    line("m2", "claude-unreleased-9", "2026-09-29T10:00:00.000Z") + line("m3", "claude-opus-5-5", "2026-09-29T10:01:00.000Z"));
  process.env.AGENT_ATLAS_CLAUDE_ROOT = root; process.env.AGENT_ATLAS_CODEX_ROOT = codexRoot;
  const providers = await import("../src/providers/index.mjs");
  const { toSessionRow, querySessions } = await import("../src/session-index.mjs");
  const refs = providers.discover().sort((a, b) => a.id.localeCompare(b.id));
  const rows = refs.map(ref => toSessionRow(ref, providers.buildTree(ref), Date.now()));
  const [unknown, mixed] = rows;
  assert.equal(unknown.costConfidence, "n/a"); assert.deepEqual(unknown.unknownModels, ["claude-unreleased-9"]);
  assert.equal(mixed.costConfidence, "partial"); assert.equal(mixed.cost, 0.024);   // 1000 × $4 + 1000 × $20 per MTok
  const tree = providers.buildTree(refs[0]);
  assert.equal(tree.calls[0].cost, null);
  assert.equal(tree.cost.provenance.length, 0);
  assert.equal(providers.buildTree(refs[1]).cost.provenance[0].model, "claude-opus-5-5");
  // min-cost defaults to $0.5: neither session's cost is fully known, so neither is filtered out.
  const result = querySessions(rows, { from: "2026-01-01" });
  assert.equal(result.matchedCount, 2); assert.equal(result.summary.unpriced, 2);
  // No breakdown group of unpriced sessions may read as a plain $0.
  for (const by of ["model", "project", "agent"])
    for (const g of querySessions(rows, { from: "2026-01-01", by }).breakdown) assert.ok(g.value > 0 || g.costConfidence === "n/a", by + ":" + g.key);
});

// --- Refresh, cache and fallback.
const PAGE_A = fs.readFileSync(new URL("./fixtures/anthropic-pricing.md", import.meta.url), "utf8");
const PAGE_O = fs.readFileSync(new URL("./fixtures/openai-pricing.md", import.meta.url), "utf8");
const serve = pages => async url => {
  const body = pages[url.includes("openai") ? "openai" : "anthropic"];
  if (body instanceof Error) throw body;
  return { ok: true, status: 200, text: async () => body };
};
async function online(fn) {
  delete process.env.AGENT_ATLAS_PRICING;
  try { return await fn(); } finally { process.env.AGENT_ATLAS_PRICING = "offline"; }
}

test("the parsers read the official page layouts", () => {
  const a = parseAnthropic(PAGE_A), o = parseOpenAI(PAGE_O);
  assert.deepEqual(a.find(r => r.model === "claude-opus-5-5").rates, { in: 4, out: 20, cr: 0.2, c5: 5, c1h: 8 });
  assert.deepEqual(a.find(r => r.model === "claude-mythos-5-1").rates, { in: 10, out: 50, cr: 0.25, c5: 12.5, c1h: 20 });
  assert.deepEqual(o.find(r => r.model === "gpt-5.5").long.rates, { in: 10, out: 45, cr: 1, c5: null, c1h: null });
  assert.throws(() => parseAnthropic("# Pricing\n\nredesigned page, no table"), /not found/);
  assert.throws(() => parseOpenAI(PAGE_O.replace(/\$10\.00/g, "ten dollars")), /unreadable price cell/);
});

test("offline mode never fetches", async () => {
  resetCache();
  let calls = 0;
  const r = await pricing.refreshPrices({ force: true, fetchImpl: async () => { calls++; throw new Error("no"); } });
  assert.equal(r.offline, true); assert.equal(calls, 0);
});

test("a failing or malformed source changes no price and is recorded", async () => {
  resetCache();
  const before = pricing.priceUsage("anthropic", "claude-opus-5-5", "2026-10-01T00:00:00Z", U({ in: M }));
  const r = await online(() => pricing.refreshPrices({ force: true,
    fetchImpl: serve({ anthropic: new Error("ECONNREFUSED"), openai: "<html>not a price page</html>" }) }));
  assert.deepEqual(r.sources.map(s => s.status), ["failed", "failed"]);
  assert.equal(r.changed, false);
  const after = pricing.priceUsage("anthropic", "claude-opus-5-5", "2026-10-01T00:00:00Z", U({ in: M }));
  assert.deepEqual(after, before);
  const cache = JSON.parse(fs.readFileSync(process.env.AGENT_ATLAS_PRICES_CACHE, "utf8"));
  assert.equal(cache.entries.length, 0); assert.match(cache.sources.anthropic.error, /ECONNREFUSED/);
  // A failed source is not retried on every scan: the next non-forced refresh waits.
  const again = await online(() => pricing.refreshPrices({ fetchImpl: serve({ anthropic: PAGE_A, openai: PAGE_O }) }));
  assert.deepEqual(again.sources.map(s => s.status), ["fresh", "fresh"]);
});

test("an unchanged page appends nothing; the TTL keeps a fresh source from being re-read", async () => {
  resetCache();
  let calls = 0;
  const fetchImpl = async url => { calls++; return serve({ anthropic: PAGE_A, openai: PAGE_O })(url); };
  const first = await online(() => pricing.refreshPrices({ force: true, fetchImpl }));
  assert.deepEqual(first.sources.map(s => [s.status, s.added]), [["ok", 0], ["ok", 0]]);
  await online(() => pricing.refreshPrices({ fetchImpl }));
  assert.equal(calls, 2);
});

test("a live price change applies from the moment it was observed; history keeps its price", async () => {
  resetCache();
  const T = new Date("2026-10-10T12:00:00.000Z");
  const earlier = "2026-10-01T00:00:00.000Z", later = "2026-10-11T00:00:00.000Z";
  const old = pricing.priceUsage("anthropic", "claude-opus-5-5", earlier, U({ in: M }));
  const cut = PAGE_A.replace(/\| Claude Opus 5\.5 (\s*)\| \$4 \/ MTok /, "| Claude Opus 5.5 $1| $3 / MTok ");
  assert.notEqual(cut, PAGE_A);
  const r = await online(() => pricing.refreshPrices({ force: true, now: () => T, fetchImpl: serve({ anthropic: cut, openai: PAGE_O }) }));
  assert.equal(r.changed, true);
  assert.deepEqual(pricing.priceUsage("anthropic", "claude-opus-5-5", earlier, U({ in: M })), old);
  const now = pricing.priceUsage("anthropic", "claude-opus-5-5", later, U({ in: M }));
  assert.equal(now.usd, 3);
  const p = pricing.provenance(now.price);
  assert.equal(p.source.kind, "live"); assert.equal(p.from, T.toISOString());
  // A later failure leaves both answers exactly where they were.
  await online(() => pricing.refreshPrices({ force: true, fetchImpl: serve({ anthropic: new Error("down"), openai: new Error("down") }) }));
  assert.deepEqual(pricing.priceUsage("anthropic", "claude-opus-5-5", earlier, U({ in: M })), old);
  assert.equal(pricing.priceUsage("anthropic", "claude-opus-5-5", later, U({ in: M })).usd, 3);
});

test("a model first seen live is priced back to its first use", async () => {
  resetCache();
  const page = PAGE_A.replace("| Claude Haiku 4.5 ", "| Claude Haiku 9 | $7 / MTok | $1 / MTok | $1 / MTok | $1 / MTok | $9 / MTok |\n| Claude Haiku 4.5 ");
  await online(() => pricing.refreshPrices({ force: true, fetchImpl: serve({ anthropic: page, openai: PAGE_O }) }));
  const r = pricing.priceUsage("anthropic", "claude-haiku-9", "2020-01-01T00:00:00Z", U({ in: M }));
  assert.equal(r.usd, 7); assert.equal(pricing.provenance(r.price).from, null);
  resetCache();
  assert.equal(pricing.priceUsage("anthropic", "claude-haiku-9", null, U({ in: M })).confidence, "n/a");
});
