import { agentMs, perAgent, subtreeTotals } from "./render.mjs";
import { describe, workspace } from "./providers/claude.mjs";

export const LIVE_MS = 120_000;
const TOKEN_KEYS = ["in", "out", "cr", "cw"];
const number = value => Number.isFinite(value) ? value : 0;

export function countAgents(node) {
  return node.children.reduce((total, child) => total + 1 + countAgents(child), 0);
}

export function toSessionRow(session, tree, now = Date.now()) {
  const totals = subtreeTotals(tree).get(tree).tot;
  const d = describe(tree);
  const w = workspace(tree);
  const model = tree.model[0] || null;
  return {
    id: session.id, project: session.project.replace(/^-/, ""), path: session.path,
    name: tree.identity?.agentName || tree.identity?.customTitle || "",
    title: d.title, subtitle: d.subtitle, desc: (tree.firstPrompt || "").slice(0, 220),
    start: tree.start, durationS: tree.durationS, live: now - session.mtimeMs < LIVE_MS,
    agents: countAgents(tree), apiCalls: tree.apiCalls, humanMsgs: tree.humanMsgs,
    costPerHumanMsg: tree.costPerHumanMsg, callsPerHumanMsg: tree.callsPerHumanMsg,
    agentMs: agentMs(tree), byAgent: perAgent(tree), model, workspace: w, version: tree.version,
    tokens: totals.t, tokenCost: totals.d, cost: tree.cost.total,
  };
}

const haystack = row => [row.id, row.project, row.name, row.title, row.subtitle, row.desc,
  row.workspace?.label, row.workspace?.cwd, row.workspace?.branch, row.model].filter(Boolean).join(" ").toLowerCase();

function normalizeDate(value, end) {
  if (!value) return end ? Infinity : 0;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid date");
  return end ? parsed + 864e5 : parsed;
}

export function normalizeSessionQuery(input = {}) {
  const limit = Math.min(Math.max(Number.parseInt(input.limit, 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(input.offset, 10) || 0, 0);
  const sort = ["start", "live", "cost", "agents", "calls", "duration", "in", "out", "cr", "cw", "project", "model", "agentMs", "humanMsgs", "title"].includes(input.sort) ? input.sort : "start";
  const dir = input.dir === "asc" ? 1 : -1;
  const minCost = input.minCost == null || input.minCost === "" ? 0.5 : Number(input.minCost);
  if (!Number.isFinite(minCost) || minCost < 0) throw new Error("invalid minCost");
  return { q: String(input.q || "").trim().toLowerCase(), project: String(input.project || ""),
    model: String(input.model || ""), live: input.live === "1", minCost: input.usemin === "0" ? 0 : minCost,
    from: input.from ? normalizeDate(input.from, false) : Date.now() - 30 * 864e5, to: normalizeDate(input.to, true), sort, dir, offset, limit,
    by: input.by === "model" || input.by === "project" ? input.by : "agent", metric: ["cost", "in", "out", "cr", "cw", "calls", "agentMs", "sessions", "agents", "humanMsgs", "duration"].includes(input.metric) ? input.metric : "cost" };
}

function metric(row, key) {
  if (key === "start") return Date.parse(row.start || 0) || 0;
  if (key === "live") return row.live ? 1 : 0;
  if (key === "project") return String(row.workspace?.label || row.project || "");
  if (key === "model" || key === "title") return String(row[key] || "");
  if (TOKEN_KEYS.includes(key)) return number(row.tokens?.[key]);
  if (key === "calls") return number(row.apiCalls);
  if (key === "sessions") return 1;
  if (key === "humanMsgs") return number(row.humanMsgs);
  if (key === "duration") return number(row.durationS);
  return number(row[key]);
}

function aggregate(rows) {
  const token = { in: 0, out: 0, cr: 0, cw: 0 }, tokenCost = { in: 0, out: 0, cr: 0, cw: 0 };
  let cost = 0, agents = 0, calls = 0, agentMs = 0, humanMsgs = 0;
  const costs = [];
  for (const row of rows) {
    cost += number(row.cost); agents += number(row.agents); calls += number(row.apiCalls);
    agentMs += number(row.agentMs); humanMsgs += number(row.humanMsgs); costs.push(number(row.cost));
    for (const key of TOKEN_KEYS) { token[key] += number(row.tokens?.[key]); tokenCost[key] += number(row.tokenCost?.[key]); }
  }
  costs.sort((a, b) => a - b);
  return { cost, agents, calls, agentMs, humanMsgs, token, tokenCost, average: rows.length ? cost / rows.length : null,
    median: rows.length ? costs[costs.length >> 1] : null, costPerHumanMsg: humanMsgs ? cost / humanMsgs : null,
    callsPerHumanMsg: humanMsgs ? calls / humanMsgs : null };
}

function breakdown(rows, by, metricKey) {
  const groups = new Map();
  const add = (key, count, value, tokenCost) => { const prior = groups.get(key) || { key, count: 0, value: 0, tokenCost: { in: 0, out: 0, cr: 0, cw: 0 } }; prior.count += count; prior.value += value; for (const k of TOKEN_KEYS) prior.tokenCost[k] += number(tokenCost?.[k]); groups.set(key, prior); };
  for (const row of rows) {
    if (by === "model" || by === "project") {
      const key = by === "project" ? (row.workspace?.label || row.project || "—") : (row.model || "—"); add(key, 1, metric(row, metricKey), row.tokenCost);
      continue;
    }
    const child = { cost: 0, agents: 0, agentMs: 0, token: { in: 0, out: 0, cr: 0, cw: 0 }, tokenCost: { in: 0, out: 0, cr: 0, cw: 0 } };
    for (const [key, agent] of Object.entries(row.byAgent || {})) {
      child.cost += number(agent.o); child.agents += number(agent.c); child.agentMs += number(agent.ms);
      for (let i = 0; i < TOKEN_KEYS.length; i++) { const tokenKey = TOKEN_KEYS[i]; child.token[tokenKey] += number(agent.t?.[i]); child.tokenCost[tokenKey] += number(agent.d?.[i]); }
      const value = metricKey === "cost" ? number(agent.o) : metricKey === "agents" || metricKey === "sessions" ? number(agent.c) : metricKey === "agentMs" ? number(agent.ms) : metricKey === "duration" ? number(agent.ms) / 1000 : metricKey === "calls" || metricKey === "humanMsgs" ? 0 : number(agent.t?.[TOKEN_KEYS.indexOf(metricKey)]);
      add(key, number(agent.c), value, Object.fromEntries(TOKEN_KEYS.map((tokenKey, i) => [tokenKey, number(agent.d?.[i])])));
    }
    const remainderTokens = Object.fromEntries(TOKEN_KEYS.map(key => [key, Math.max(0, number(row.tokens?.[key]) - child.token[key])]));
    const remainderCost = Object.fromEntries(TOKEN_KEYS.map(key => [key, Math.max(0, number(row.tokenCost?.[key]) - child.tokenCost[key])]));
    const mainValue = metricKey === "cost" ? Math.max(0, number(row.cost) - child.cost) : metricKey === "agents" ? Math.max(0, number(row.agents) - child.agents) : metricKey === "sessions" ? 1 : metricKey === "calls" ? number(row.apiCalls) : metricKey === "humanMsgs" ? number(row.humanMsgs) : metricKey === "duration" ? number(row.durationS) : metricKey === "agentMs" ? Math.max(0, number(row.agentMs) - child.agentMs) : remainderTokens[metricKey];
    if (mainValue || TOKEN_KEYS.some(key => remainderTokens[key] || remainderCost[key])) add("main", 1, mainValue, remainderCost);
  }
  return [...groups.values()].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}
export function querySessions(rows, input) {
  const q = normalizeSessionQuery(input);
  const matched = rows.filter(row => number(row.cost) >= q.minCost && (!q.project || (row.workspace?.label || row.project) === q.project) &&
    (!q.model || row.model === q.model) && (!q.live || row.live) && (!row.start || (Date.parse(row.start) >= q.from && Date.parse(row.start) <= q.to)) &&
    (!q.q || haystack(row).includes(q.q)));
  matched.sort((a, b) => { const av = metric(a, q.sort), bv = metric(b, q.sort); const compared = typeof av === "string" ? av.localeCompare(bv) : av - bv; return q.dir * (compared || a.id.localeCompare(b.id)); });
  const projects = [...new Set(rows.map(row => row.workspace?.label || row.project).filter(Boolean))].sort();
  const models = [...new Set(rows.map(row => row.model).filter(Boolean))].sort();
  const pageRows = matched.slice(q.offset, q.offset + q.limit).map(({ path, byAgent, ...row }) => row);
  return { offset: q.offset, limit: q.limit, matchedCount: matched.length, rows: pageRows, summary: aggregate(matched),
    breakdown: breakdown(matched, q.by, q.metric), facets: { projects, models } };
}
