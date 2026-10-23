// Cursor provider adapter. Unlike Claude and Codex there are no local files:
// events come from Cursor's Admin API (see ../cursor-api.mjs), cached on disk by
// a sync that runs outside discovery. This module only reads that cache, so it
// stays synchronous and offline like the other providers.
//
// Cursor has no session id. Events are grouped into sessions by `conversationId`
// when Cursor sends one, otherwise by user with a gap of more than 30 minutes
// starting a new session. Each event is one request: one turn holding one call.
//
// Cost is Cursor's own `tokenUsage.totalCents` (provider-reported, confidence
// "reported"). Per-token-class cost parts are not available from Cursor, so
// they stay zero. Request-based events (isTokenBasedCall=false) carry no tokens
// or dollar amount and make the session "partial".
import crypto from "node:crypto";
import fs from "node:fs";
import { eventsPath, readCachedEvents } from "../cursor-api.mjs";
import { ZERO_PARTS } from "../prices.mjs";
import { finish } from "./node.mjs";

export const name = "cursor";
export const GAP_MS = 30 * 60_000;
const ZERO_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

const sessionId = key => {
  const h = crypto.createHash("sha1").update(key).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
};

export function groupEvents(events) {
  const sorted = events.map(e => ({ ...e, ts: Number(e.timestamp) })).filter(e => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);
  const groups = new Map(), openGap = new Map();
  for (const e of sorted) {
    let key;
    if (e.conversationId) key = "c:" + e.conversationId;
    else {
      const user = e.userEmail || "";
      const open = openGap.get(user);
      if (open && e.ts - open.last <= GAP_MS) { open.last = e.ts; key = open.key; }
      else { key = "g:" + user + ":" + e.ts; openGap.set(user, { key, last: e.ts }); }
    }
    if (!groups.has(key)) groups.set(key, { key, id: sessionId(key), events: [] });
    groups.get(key).events.push(e);
  }
  return [...groups.values()];
}

let memo = null;
function sessions() {
  let stat; try { stat = fs.statSync(eventsPath()); } catch { return []; }
  const stamp = stat.mtimeMs + ":" + stat.size;
  if (!memo || memo.stamp !== stamp) memo = { stamp, groups: groupEvents(readCachedEvents()), size: stat.size };
  return memo.groups;
}

export function discover() {
  return sessions().map(g => ({ provider: name, id: g.id, project: "cursor", path: eventsPath(),
    mtimeMs: g.events.at(-1).ts, size: g.events.length }));
}

export function refFromPath() { return null; }

export function buildTree(ref) {
  const g = sessions().find(s => s.id === ref.id);
  if (!g) throw new Error(`no cursor session '${ref.id}'`);
  const tokens = ZERO_TOKENS(), models = new Map(), unknown = new Set();
  let cost = 0, partial = false;
  const turns = [], calls = [];
  g.events.forEach((e, i) => {
    const u = e.tokenUsage;
    const t = { input: u?.inputTokens || 0, output: u?.outputTokens || 0, cacheRead: u?.cacheReadTokens || 0, cacheWrite5m: u?.cacheWriteTokens || 0, cacheWrite1h: 0 };
    const usd = u ? (u.totalCents || 0) / 100 : 0;
    if (!u) { partial = true; unknown.add(e.model || "unknown"); }
    for (const k in t) tokens[k] += t[k];
    cost += usd;
    models.set(e.model, (models.get(e.model) || 0) + t.input + t.output + t.cacheRead + t.cacheWrite5m);
    const iso = new Date(e.ts).toISOString();
    turns.push({ ordinal: i + 1, start: iso, end: iso, apiCalls: 1, cost: usd, tokens: { ...t }, costParts: ZERO_PARTS(),
      skills: [], human: false, decisions: 0, subagents: [], tools: {} });
    calls.push({ id: `${g.id}:${i}`, ts: iso, cost: usd, model: e.model, tokens: { ...t }, costParts: ZERO_PARTS(),
      acts: [], opensHuman: false, gates: 0 });
  });
  const first = g.events[0], last = g.events.at(-1);
  const convo = first.conversationId;
  const st = {
    model: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m).filter(Boolean),
    effort: [], start: new Date(first.ts).toISOString(), end: new Date(last.ts).toISOString(),
    durationS: Math.round((last.ts - first.ts) / 1000), apiCalls: g.events.length, userMsgs: 0, humanMsgs: 0,
    decisions: 0, interactions: [], tokens, costOwn: cost, costParts: ZERO_PARTS(),
    costConfidence: partial ? "partial" : "reported", unknownModels: [...unknown],
    firstPrompt: null, summary: null, skills: [], branch: null, cwd: null, version: null, repo: null,
    identity: { customTitle: convo ? `Cursor conversation ${convo.slice(0, 8)}` : `Cursor · ${first.userEmail || "unknown user"}` },
    turns, turnByToolUse: null, calls,
  };
  return finish("main", "(session)", ref.id, "root", st, [], { provider: name }, null);
}
