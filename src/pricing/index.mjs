// Runtime pricing. One owner of "what does a token of model X cost".
//
//   overrides (local file)  >  litellm  >  openrouter        (first source that knows the model)
//   each catalogue = newest of: on-disk cache | bundled snapshot
//
// Lookup is synchronous and in-memory, so cost computation never waits on the
// network. refresh() is the only thing that touches it: a source is re-read at
// most every TTL_MS (RETRY_MS after a failure), validated, and persisted
// atomically. A failed, slow or malformed refresh changes nothing: the last good
// catalogue (cache, else bundled snapshot) keeps answering, however old.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { exactId, candidates } from "./match.mjs";
import { SOURCES, SOURCE_ORDER, MIN_MODELS } from "./sources.mjs";

export const TTL_MS = 24 * 3600e3;
export const RETRY_MS = 3600e3;
const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "snapshot.json");

const env = () => process.env;
export const offline = () => env().AGENT_ATLAS_PRICING === "offline";
export const cacheFile = () => env().AGENT_ATLAS_PRICES_CACHE ||
  path.join(env().XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agent-atlas", "prices.json");
export const overridesFile = () => env().AGENT_ATLAS_PRICES_OVERRIDE ||
  path.join(env().XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-atlas", "prices.json");

// state.sources[name] = {origin: "cache"|"bundled", fetchedAt, url, models: Map, lastAttempt, error}
let state = null, revision = 0, overrides = new Map(), overridesStamp = "";

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const toMap = obj => new Map(Object.entries(obj || {}));
const fromMap = map => Object.fromEntries(map);
const validEntry = e => e && typeof e === "object" && e.p && typeof e.p.in === "number" && typeof e.p.out === "number";

function loadSource(name, snap, cache) {
  const usable = d => d && typeof d.fetchedAt === "string" && d.models && Object.keys(d.models).length >= MIN_MODELS;
  const pick = usable(cache) && (!usable(snap) || cache.fetchedAt >= snap.fetchedAt) ? ["cache", cache] : usable(snap) ? ["bundled", snap] : [null, null];
  const [origin, d] = pick;
  const models = new Map(origin ? Object.entries(d.models).filter(([, e]) => validEntry(e)) : []);
  return { origin: origin || "none", fetchedAt: d?.fetchedAt ?? null, version: d?.version ?? null, url: SOURCES[name].url, models,
    lastAttempt: cache?.lastAttempt ?? null, error: cache?.error ?? null };
}

function loadOverrides() {
  const file = overridesFile(); let stamp = "";
  try { const st = fs.statSync(file); stamp = st.mtimeMs + ":" + st.size; } catch { /* none */ }
  if (stamp === overridesStamp && state) return false;
  overridesStamp = stamp; overrides = new Map();
  const data = stamp ? readJson(file) : null;
  for (const [model, v] of Object.entries(data || {})) {
    const canon = exactId(model);
    if (!canon || !v || typeof v.in !== "number" || typeof v.out !== "number") continue;
    const n = k => (typeof v[k] === "number" && v[k] >= 0 ? v[k] : null);
    overrides.set(canon, { key: model, p: { in: v.in, out: v.out, cr: n("cr"), cw5: n("cw5"), cw1h: n("cw1h") } });
  }
  return true;
}

function init() {
  if (state) return;
  const snap = readJson(SNAPSHOT)?.sources || {}, cache = readJson(cacheFile())?.sources || {};
  state = {};
  for (const name of SOURCE_ORDER) state[name] = loadSource(name, snap[name], cache[name]);
  loadOverrides(); revision++;
}

/** Changes whenever any answer could change; the index uses it to re-price sessions. */
export function pricingRevision() { init(); return revision + ":" + overridesStamp; }

/** Test hook: forget everything read from disk. */
export function resetPricing() { state = null; overrides = new Map(); overridesStamp = ""; revision = 0; }

/**
 * The price of a model, with where it came from, or null when no source knows it.
 * {p: {in,out,cr,cw5,cw1h} $/MTok (null = unpublished), provenance}
 */
export function lookup(model) {
  init(); loadOverrides();
  // Most specific identity first, in every source, before any looser one.
  for (const id of candidates(model)) {
    const o = overrides.get(id);
    if (o) return hit(model, "override", { origin: "override", fetchedAt: null, version: "file:" + overridesStamp, url: overridesFile() }, o);
    for (const name of SOURCE_ORDER) {
      const src = state[name], e = src.models.get(id);
      if (e) return hit(model, name, src, e, src.origin === "cache" && Date.now() - Date.parse(src.fetchedAt) > TTL_MS * 7 ? { stale: true } : {});
    }
  }
  return null;
}

// Provenance is self-contained: the rates that were applied, their unit and
// currency, and an immutable identifier of the catalogue version they came from
// (a content hash), so the answer can be re-derived without trusting the URL.
function hit(model, kind, src, e, extra = {}) {
  return { p: e.p, provenance: { model, source: kind, matchedKey: e.key, origin: src.origin, fetchedAt: src.fetchedAt,
    sourceVersion: src.version ?? null, url: src.url, currency: "USD", unit: "USD per 1M tokens", rates: { ...e.p }, ...extra } };
}

/**
 * Price one usage record {in,out,cr,c5,c1h} (tokens). Same return shape the
 * price tables always had, plus `provenance` and an explicit unknown state:
 *   confidence "n/a"     no source knows the model        (usd 0, never a price)
 *   confidence "partial" a token class was used but unpublished (lower bound)
 *   confidence "computed" list price x tokens
 */
export const ZERO_PARTS = () => ({ in: 0, out: 0, cr: 0, cw: 0 });
export function priceUsage(model, u) {
  const hit = lookup(model);
  if (!hit) return { usd: 0, parts: ZERO_PARTS(), confidence: "n/a", unknownModel: model ?? "(unattributed)", provenance: null };
  const p = hit.p, missing = [];
  const cost = (tokens, rate, name) => {
    if (!tokens) return 0;
    if (rate == null) { missing.push(name); return 0; }
    return tokens * rate / 1e6;
  };
  const cw5 = cost(u.c5, p.cw5, "cacheWrite5m"), cw1h = cost(u.c1h, p.cw1h, "cacheWrite1h");
  const parts = { in: cost(u.in, p.in, "input"), out: cost(u.out, p.out, "output"), cr: cost(u.cr, p.cr, "cacheRead"), cw: cw5 + cw1h };
  const usd = parts.in + parts.out + parts.cr + parts.cw;
  return { usd, parts, confidence: missing.length ? "partial" : "computed", provenance: hit.provenance,
    ...(missing.length ? { missingClasses: missing } : {}) };
}

// ---------------------------------------------------------------------------
// Refresh
async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > 50e6) throw new Error("payload too large");
  const text = await res.text();
  // The version is a hash of the bytes actually priced from: immutable, unlike the URL.
  return { json: JSON.parse(text), version: "sha256:" + crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) };
}

// Cross-process lock around the read-merge-write of the cache file. Two atlas
// processes (serve + a CLI call) can refresh at once; without this the later
// writer would overwrite the other's entries with the state it read before fetching.
async function withLock(file, fn) {
  const lock = file + ".lock", deadline = Date.now() + 3000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, "wx")); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) fs.rmSync(lock, { force: true }); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error("cache lock busy");
      await new Promise(r => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/**
 * Apply this refresh's outcomes to whatever is on disk NOW. results[name] is
 * {ok: {models, fetchedAt, version, url, attempt}} or {fail: {message, attempt}}.
 * A success merges over the disk entries; a failure touches only the attempt
 * bookkeeping. Nothing in the document is ever dropped.
 */
async function persist(results) {
  const file = cacheFile(); fs.mkdirSync(path.dirname(file), { recursive: true });
  await withLock(file, () => {
    const disk = readJson(file)?.sources || {}, out = { ...disk };
    for (const [name, r] of Object.entries(results)) {
      const rec = disk[name] || {};
      if (r.ok) {
        const models = { ...(rec.models || {}), ...fromMap(r.ok.models) };
        // Never move a newer concurrent fetch backwards.
        const newer = rec.fetchedAt && rec.fetchedAt > r.ok.fetchedAt;
        out[name] = { ...(newer ? rec : { fetchedAt: r.ok.fetchedAt, version: r.ok.version }), url: r.ok.url, models, lastAttempt: r.ok.fetchedAt, error: null };
      } else out[name] = { ...rec, lastAttempt: r.fail.attempt, error: r.fail.message };
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sources: out }));
    fs.renameSync(tmp, file);
  });
}

/**
 * Re-read every source that is due, in parallel. Never throws, never partially
 * applies a source. Returns {refreshed: [...], failed: {name: message}}.
 */
export async function refresh({ timeoutMs = 10_000, force = false, fetchJson: fetcher = fetchJson } = {}) {
  init(); loadOverrides();
  const out = { refreshed: [], failed: {} };
  if (offline()) return out;
  const disk = readJson(cacheFile())?.sources || {}, results = {};
  await Promise.all(SOURCE_ORDER.map(async name => {
    const cur = state[name], rec = disk[name] || {};
    const last = Date.parse(rec.lastAttempt || 0) || 0;
    if (!force && last && Date.now() - last < (rec.error ? RETRY_MS : TTL_MS)) return;
    const now = new Date().toISOString();
    try {
      const got = await fetcher(SOURCES[name].url, timeoutMs);
      const fresh = SOURCES[name].parse(got.json);
      if (fresh.size < MIN_MODELS) throw new Error(`only ${fresh.size} priced models; refusing to replace a good catalogue`);
      // Merge over the previous catalogue: a model an upstream delists keeps its
      // last known price, so old sessions do not fall back to "unknown".
      const models = new Map([...cur.models, ...fresh]);
      results[name] = { ok: { models, fetchedAt: now, version: got.version ?? null, url: SOURCES[name].url } };
      Object.assign(cur, { origin: "cache", fetchedAt: now, version: got.version ?? null, models, lastAttempt: now, error: null });
      out.refreshed.push(name);
    } catch (e) {
      out.failed[name] = String(e?.message || e);
      results[name] = { fail: { message: out.failed[name], attempt: now } };
      cur.error = out.failed[name];
    }
  }));
  if (Object.keys(results).length) {
    try { await persist(results); } catch (e) { out.failed.cache = String(e?.message || e); }
  }
  if (out.refreshed.length) revision++;
  return out;
}

/** Snapshot of the catalogues: what is loaded, from where, how old. For UI and diagnostics. */
export function pricingStatus() {
  init();
  return { offline: offline(), overrides: overrides.size,
    sources: SOURCE_ORDER.map(name => ({ name, origin: state[name].origin, fetchedAt: state[name].fetchedAt,
      models: state[name].models.size, lastAttempt: state[name].lastAttempt, error: state[name].error })) };
}

/** Used by scripts/pricing-snapshot.mjs: a bundled-snapshot payload from live sources. */
export async function buildSnapshot(fetcher = fetchJson, filter = () => true) {
  const sources = {}, now = new Date().toISOString();
  for (const name of SOURCE_ORDER) {
    const got = await fetcher(SOURCES[name].url, 60_000), models = SOURCES[name].parse(got.json);
    if (models.size < MIN_MODELS) throw new Error(`${name}: only ${models.size} models`);
    sources[name] = { fetchedAt: now, version: got.version ?? null, url: SOURCES[name].url, models: fromMap(new Map([...models].filter(([k, e]) => filter(k, e)))) };
  }
  return { version: 1, sources };
}
