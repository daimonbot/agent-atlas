// Pricing: what one API call cost, and where that number came from.
//
// There is no price table in the source. Prices live in a ledger of dated
// entries, one per (vendor, model, rate set), assembled from two files:
//
//   snapshot.json   bundled with the release: the last-known official prices,
//                   written by `npm run prices:snapshot` from the same sources
//                   and parsers the runtime uses. It is what an offline host,
//                   or a host whose first refresh has not finished, prices with.
//   the local cache prices observed live at runtime (see refreshPrices()),
//                   under $XDG_CACHE_HOME/agent-atlas/prices.json by default.
//
// The ledger is append-only, and that is what keeps a historical answer fixed.
// A refresh that sees new rates for a model appends an entry effective FROM THE
// MOMENT IT WAS OBSERVED; nothing before that moment can resolve to it. A model's
// first entry has `from: null` -- the earliest price known for it applies back to
// its first use, since no page states when a price started. A failed or partial
// refresh appends nothing, and a model missing from a later page is not removed.
//
// A call whose model has no entry is unpriced: usd 0 with confidence "n/a" and
// the model named in unknownModel. Callers carry that as "unknown", never as a
// real $0 -- see node.mjs and the renderers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, candidates } from "./sources.mjs";

export const TTL_MS = 24 * 3600e3;          // a source is re-read once a day
export const RETRY_MS = 3600e3;             // a failed source is retried after an hour
const SCHEMA = 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, "snapshot.json");

export const ZERO_PARTS = () => ({ in: 0, out: 0, cr: 0, cw: 0 });

/** AGENT_ATLAS_PRICES_CACHE overrides the file; the directory is XDG's cache dir. */
export const cachePath = () => process.env.AGENT_ATLAS_PRICES_CACHE ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agent-atlas", "prices.json");
/** AGENT_ATLAS_PRICING=offline: never touch the network; bundled snapshot + cache only. */
export const offline = () => process.env.AGENT_ATLAS_PRICING === "offline";

const emptyStore = () => ({ schema: SCHEMA, sources: {}, entries: [] });
function readStore(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s && s.schema === SCHEMA && Array.isArray(s.entries)) return { sources: {}, ...s };
  } catch { /* absent or unreadable: an empty store, never an error */ }
  return emptyStore();
}

const entryId = e => `${e.vendor}/${e.model}@${e.observedAt}`;
const sameRates = (a, b) => JSON.stringify([a.rates, a.long ?? null]) === JSON.stringify([b.rates, b.long ?? null]);

// In-memory state: the merged ledger, keyed "vendor/model" -> entries sorted by
// `from` (null first). `revision` moves whenever the ledger changes, so callers
// holding priced results can tell theirs are stale.
let state = null;
let revision = 0;

function build(snapshot, cache) {
  const byKey = new Map(), byId = new Map();
  const add = (e, kind) => {
    const k = e.vendor + "/" + e.model, list = byKey.get(k) || [];
    // Two entries with the same `from` (a model first observed live, later also
    // shipped in a snapshot): the earlier observation wins, because that is the
    // answer the user has already been shown.
    const clash = list.findIndex(x => x.from === e.from);
    if (clash >= 0) { if (list[clash].observedAt <= e.observedAt) return; list.splice(clash, 1); }
    const x = { ...e, kind, id: entryId(e), fromMs: e.from == null ? -Infinity : Date.parse(e.from) };
    list.push(x); byKey.set(k, list);
  };
  for (const e of snapshot.entries) add(e, "bundled");
  for (const e of cache.entries) add(e, "live");
  for (const list of byKey.values()) {
    list.sort((a, b) => a.fromMs - b.fromMs);
    for (const x of list) byId.set(x.id, x);
  }
  return { snapshot, cache, byKey, byId };
}

function load() {
  if (!state) state = build(readStore(SNAPSHOT), readStore(cachePath()));
  return state;
}

/** Drop the in-memory ledger; the next lookup re-reads snapshot and cache. */
export function reload() { state = null; revision++; }
export const pricingRevision = () => revision;

/** The entry in force for `vendor/model` at ISO time `ts`, or null. */
export function resolve(vendor, model, ts) {
  if (model == null) return null;
  const { byKey } = load();
  for (const m of candidates(vendor, model)) {
    const list = byKey.get(vendor + "/" + m);
    if (!list) continue;
    const t = ts ? Date.parse(ts) : NaN;
    // No timestamp: the earliest entry, the one answer that can never move.
    if (!Number.isFinite(t)) return list[0];
    let hit = list[0];
    for (const x of list) if (x.fromMs <= t) hit = x;
    return hit;
  }
  return null;
}

/**
 * Price one call. `u` is {in, out, cr, c5, c1h} tokens.
 * Returns {usd, parts, confidence, price} where `price` is the provenance id of
 * the entry used (see provenance()), or, when no entry exists, usd 0 with
 * confidence "n/a" and `unknownModel` set. A token class with tokens but no
 * published rate leaves that part unpriced and the call "partial".
 */
export function priceUsage(vendor, model, ts, u) {
  const e = resolve(vendor, model, ts);
  if (!e) return { usd: 0, parts: ZERO_PARTS(), confidence: "n/a", unknownModel: model, price: null };
  const r = e.long && u.in + u.cr + u.c5 + u.c1h > e.long.above ? e.long.rates : e.rates;
  let missing = false;
  const part = k => {
    if (!u[k]) return 0;
    if (r[k] == null) { missing = true; return 0; }
    return u[k] * r[k] / 1e6;
  };
  const parts = { in: part("in"), out: part("out"), cr: part("cr"), cw: part("c5") + part("c1h") };
  const usd = parts.in + parts.out + parts.cr + parts.cw;
  const confidence = missing ? "partial" : e.verified ? "verified" : "computed";
  return { usd, parts, confidence, price: e.id, ...(missing ? { unknownModel: `${model} (unpublished rate)` } : {}) };
}

/** Machine-readable provenance of a price id returned by priceUsage(). */
export function provenance(id) {
  const e = load().byId.get(id);
  if (!e) return null;
  const src = (e.kind === "bundled" ? state.snapshot : state.cache).sources[e.vendor] || {};
  return { id: e.id, vendor: e.vendor, model: e.model, currency: "USD", unit: "per 1M tokens",
    rates: e.rates, long: e.long ?? null, from: e.from, observedAt: e.observedAt,
    source: { kind: e.kind, url: e.url || src.page || null },
    ...(e.verified ? { verified: e.verified } : {}) };
}

/**
 * Merge freshly parsed rows into `store` (mutated). Appends only on change, and
 * only relative to everything already known (bundled + cached), so re-reading an
 * unchanged page writes nothing. Returns the number of entries appended.
 */
export function observe(store, known, source, rows, observedAt) {
  let added = 0;
  for (const r of rows) {
    const list = known.get(source.vendor + "/" + r.model) || [];
    const latest = list[list.length - 1];
    if (latest && sameRates(latest, r)) continue;
    const e = { vendor: source.vendor, model: r.model, from: latest ? observedAt : null, observedAt,
      rates: r.rates, long: r.long ?? null, url: source.page };
    store.entries.push(e);
    known.set(source.vendor + "/" + r.model, [...list, { ...e, fromMs: Date.parse(observedAt) }]);
    added++;
  }
  return added;
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // One entry per line: a refreshed snapshot diffs as exactly the lines appended.
  const { entries, ...head } = store;
  fs.writeFileSync(tmp, JSON.stringify(head, null, 1).replace(/\n}$/, ',\n "entries": [\n') +
    entries.map(e => "  " + JSON.stringify(e)).join(",\n") + "\n ]\n}\n");
  fs.renameSync(tmp, file);
}

let inflight = null;
/**
 * Re-read every source whose last read is older than TTL_MS (or all, with
 * force). Never throws and never blocks a caller that does not await it: a
 * failure is recorded per source and changes no price. Resolves to
 * {changed, sources: [{vendor, status, added?, error?}]}.
 */
export function refreshPrices({ force = false, timeoutMs = 10_000, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (offline()) return Promise.resolve({ changed: false, sources: [], offline: true });
  if (inflight) return inflight;
  inflight = (async () => {
    const file = cachePath();
    const results = [];
    let changed = false;
    for (const source of SOURCES) {
      // Re-read the file per source: another process may have written it.
      const store = readStore(file);
      const prev = store.sources[source.vendor] || {};
      const t = now();
      const last = Date.parse(prev.retrievedAt || 0) || 0, tried = Date.parse(prev.attemptedAt || 0) || 0;
      if (!force && (t - last < TTL_MS || t - tried < RETRY_MS)) { results.push({ vendor: source.vendor, status: "fresh" }); continue; }
      const observedAt = t.toISOString();
      try {
        const res = await fetchImpl(source.url, { signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "text/markdown, text/plain" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = source.parse(await res.text());
        const known = build(readStore(SNAPSHOT), store).byKey;
        const added = observe(store, known, source, rows, observedAt);
        store.sources[source.vendor] = { page: source.page, url: source.url, retrievedAt: observedAt,
          attemptedAt: observedAt, models: rows.length, error: null };
        writeStore(file, store);
        if (added) changed = true;
        results.push({ vendor: source.vendor, status: "ok", added });
      } catch (e) {
        const error = e && e.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : String(e && e.message || e);
        store.sources[source.vendor] = { ...prev, attemptedAt: observedAt, error };
        try { writeStore(file, store); } catch { /* an unwritable cache is not fatal either */ }
        results.push({ vendor: source.vendor, status: "failed", error });
      }
    }
    if (changed) reload(); else state = null;   // re-read status either way; revision moves only on change
    return { changed, sources: results };
  })().finally(() => { inflight = null; });
  return inflight;
}

/** For the snapshot script: the bundled file's path and its reader/writer. */
export const snapshotFile = SNAPSHOT;
export { readStore, writeStore, build };
