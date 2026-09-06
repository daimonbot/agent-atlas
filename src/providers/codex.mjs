// Codex CLI provider adapter.
//
// Codex keeps its own record of every session it ran, and this module reads it
// the same way the claude provider reads Claude's transcripts: whatever is
// already on disk, read-only, no cooperation asked of anyone.
//
//   <root>/state_5.sqlite          threads (metadata, git, cwd, model, timing),
//                                  thread_spawn_edges (native parent -> child)
//   <root>/thread_history_1.sqlite thread_turns (per-turn timing),
//                                  thread_items (per-turn activity)
//   <root>/sessions/**/rollout-*.jsonl
//                                  the append-only log, and the ONLY place a
//                                  per-response token breakdown exists
//
// root defaults to ~/.codex and is overridable with AGENT_ATLAS_CODEX_ROOT.
// Unlike AGENT_ATLAS_CLAUDE_ROOT, which points at a sessions directory, this one
// points at a home directory, because Codex's three inputs are siblings rather
// than one tree. Every input is derived from it, including the rollout path --
// threads.rollout_path is absolute and is only trusted when it falls inside the
// active root, otherwise it is rebased onto it (see resolveRollout).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ZERO_PARTS, priceCodex } from "../prices.mjs";
import { finish } from "./node.mjs";

export const name = "codex";
export const root = () =>
  process.env.AGENT_ATLAS_CODEX_ROOT || path.join(os.homedir(), ".codex");
const statePath = () => path.join(root(), "state_5.sqlite");
const historyPath = () => path.join(root(), "thread_history_1.sqlite");

const ZERO_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// One line per distinct condition, never one per session: a store that fails to
// open fails for every thread in it, and 1400 identical lines would bury the run.
const said = new Set();
function warn(msg) {
  if (said.has(msg)) return;
  said.add(msg);
  console.error("agent-atlas: codex: " + msg);
}

// ---------------------------------------------------------------------------
// node:sqlite, reached lazily and never at module scope.
//
// process.getBuiltinModule("node:sqlite") prints Node's "SQLite is an
// experimental feature" warning at the moment the builtin is FETCHED (a static
// `import` prints it on load even if the binding is never used). The registry
// loads this module on every `agent-atlas list`, so materialising it at module
// scope would put that line on stderr for every Claude-only user on every
// invocation and pollute --json pipelines. The fetch therefore happens only
// past discover()'s existence gate.
//
// A falsy result is the same degrade as a throw: getBuiltinModule returns
// undefined for a builtin this Node does not ship, so a bare try/catch around
// the fetch would not degrade at all -- it would fail later at the destructure.
let SQL = null, sqlFetched = false;
function sqlite() {
  if (sqlFetched) return SQL;
  sqlFetched = true;
  try { SQL = process.getBuiltinModule("node:sqlite") || null; } catch { SQL = null; }
  if (!SQL || typeof SQL.DatabaseSync !== "function") {
    SQL = null;
    warn("node:sqlite is unavailable on this Node build; no Codex sessions");
  }
  return SQL;
}

// Handles are opened once and reused for the process lifetime: server.mjs calls
// discover() every --interval seconds, and an open-without-close would leak two
// descriptors per scan. A failed open is memoised too, so the warning is said
// once and the failing store is not reopened on every pass.
const handles = new Map();
function open(file) {
  if (handles.has(file)) return handles.get(file);
  let h = null;
  const S = sqlite();
  if (S) {
    try {
      // readOnly is the provable form of "never writes": the store belongs to
      // Codex. Never retried read-write on failure.
      h = new S.DatabaseSync(file, { readOnly: true });
    } catch (e) {
      warn(`cannot open ${file} read-only: ${e.message}`);
    }
  }
  handles.set(file, h);
  return h;
}

// Any sqlite access failure degrades, and it can surface at prepare()/all()
// rather than at the constructor -- a WAL database in a non-writable directory
// with no -shm present opens and then fails on first read.
function rows(h, sql, ...args) {
  if (!h) return null;
  try { return h.prepare(sql).all(...args); } catch (e) {
    warn(`query failed (${sql.slice(0, 40)}...): ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// turns[].tools is an allowlist of tool-invocation item types, not a
// "everything that is not a message" rule. Claude's tools map is built only from
// tool_use block names (parse.mjs:320), i.e. it is an allowlist by construction
// and means "tool invocations"; `reasoning` and `contextCompaction` are
// transcript item kinds, and counting them would make one field mean two
// different things on the two providers.
const TOOL_ITEMS = new Set(["commandExecution"]);
const NON_TOOL_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "contextCompaction"]);

// The allowlist's own failure mode: an item_type on neither list is a Codex tool
// kind nobody has classified yet, and silently dropping it would make a future
// tool invisible. Reported once per process, as ONE line naming every such type
// (this host already carries two -- fileChange and webSearch -- and a line each
// would exceed the one line a degraded run is allowed on stderr).
const unclassified = new Set();
let flushArmed = false;
function noteItemType(t) {
  if (TOOL_ITEMS.has(t) || NON_TOOL_ITEMS.has(t) || unclassified.has(t)) return;
  unclassified.add(t);
  if (flushArmed) return;
  flushArmed = true;
  const flush = () => {
    if (!unclassified.size) return;
    warn(`thread_items carries item_type(s) missing from the tool allowlist: ` +
         `${[...unclassified].sort().join(", ")} — not counted in turns[].tools`);
    unclassified.clear();
  };
  setImmediate(flush);        // prompt under `serve`, which never exits
  process.on("exit", flush);  // and still said when cli.mjs exits first
}

// ---------------------------------------------------------------------------
// Rollout-path resolution, root-contained.
//
// threads.rollout_path is an absolute path into whatever store wrote it. Trusting
// it unconditionally would make AGENT_ATLAS_CODEX_ROOT a half-override: a fixture
// copy of the store would redirect the two sqlite files and keep reading the real
// rollouts from ~/.codex. Every other path in this project is derived from a
// root, and this restates that invariant for a store that hands out absolute
// paths.
const isInside = (r, p) => path.resolve(p).startsWith(path.resolve(r) + path.sep);

function resolveRollout(stored) {
  const r = root();
  if (stored && isInside(r, stored) && fs.existsSync(stored)) return stored;
  const i = stored ? stored.lastIndexOf("/sessions/") : -1;
  if (i >= 0) {
    const rebased = path.join(r, stored.slice(i + 1));
    if (fs.existsSync(rebased)) return rebased;
  }
  return null;                                 // the degraded path: see buildTree
}

// ---------------------------------------------------------------------------
// The rollout reader. Returns the reader's PRODUCT -- plain data, no node
// objects and no objects any consumer mutates -- or null when there is nothing
// readable. This is what gets memoised (see rollFor): every buildTree call
// composes a fresh turns[]/calls[] out of it, because finish() writes onto both
// (turn.subagents, call.opensHuman) and a shared array would accumulate.
function readRollout(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    warn(`cannot read rollout ${file}: ${e.message}`);
    return null;
  }

  // Pass 1: every turn_context, and every usage record, in file order. The two
  // passes are not optional: a token_usage_record can precede its own
  // turn_context in the same file (measured), so a streaming model -> record
  // join mis-attributes or throws.
  const ctx = new Map();                       // turn_id -> {model, effort}
  const recs = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let x;
    // A garbage line, or the partial trailing line of a file being appended to
    // while it is read, is skipped -- never thrown on. That is the property the
    // whole ingestion model rests on.
    try { x = JSON.parse(line); } catch { continue; }
    const p = x && x.payload;
    if (!p) continue;
    if (x.type === "turn_context") {
      if (p.turn_id != null && !ctx.has(p.turn_id))
        ctx.set(p.turn_id, { model: p.model ?? null, effort: p.effort ?? null });
    } else if (x.type === "token_usage_record" && p.usage) {
      recs.push({ ts: x.timestamp, id: p.response_id, turnId: p.turn_id ?? null,
                  rootTurnId: p.root_turn_id ?? null, u: p.usage, tot: p.thread_token_usage });
    }
  }

  const models = [], efforts = [];
  for (const c of ctx.values()) {
    if (c.model != null && !models.includes(c.model)) models.push(c.model);
    if (c.effort != null && !efforts.includes(c.effort)) efforts.push(c.effort);
  }

  // Pass 2: price every record with its own turn's model.
  const tokens = ZERO_TOKENS();
  const raw = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
  const ids = new Set(), unknown = new Set(), byModel = new Map();
  const costParts = ZERO_PARTS();
  const turns = new Map();                     // turn_id -> {usd(raw), apiCalls, tokens, costParts}
  const calls = [];
  let priced = 0, unpriced = 0;

  for (const r of recs) {
    const u = r.u;
    const cached = u.cached_input_tokens || 0;
    // input_tokens INCLUDES cached_input_tokens on Codex (they are disjoint on
    // Anthropic), so the subtraction is mandatory: without it the cached half is
    // counted twice and priced at ~10x its real rate.
    const uu = { in: (u.input_tokens || 0) - cached, out: u.output_tokens || 0,
                 cr: cached, c5: u.cache_write_input_tokens || 0, c1h: 0 };
    // reasoning_output_tokens is deliberately NOT added: it is already inside
    // output_tokens (total_tokens == input_tokens + output_tokens holds on every
    // record on this host). Read output_tokens and stop.
    tokens.input += uu.in; tokens.cacheRead += uu.cr;
    tokens.output += uu.out; tokens.cacheWrite5m += uu.c5;
    raw.input_tokens += u.input_tokens || 0; raw.cached_input_tokens += cached;
    raw.output_tokens += u.output_tokens || 0;
    raw.cache_write_input_tokens += u.cache_write_input_tokens || 0;
    if (r.id != null) ids.add(r.id);

    let model = r.turnId != null && ctx.has(r.turnId) ? ctx.get(r.turnId).model : null;
    if (model == null && r.rootTurnId != null && ctx.has(r.rootTurnId))
      model = ctx.get(r.rootTurnId).model;

    let pr;
    if (model == null) {
      // Never fall back to threads.model here: that is the last-model-wins column,
      // and it produces an entirely plausible-looking wrong number.
      pr = { usd: 0, parts: ZERO_PARTS(), confidence: "n/a" };
      unknown.add("(unattributed)");
    } else {
      pr = priceCodex(model, r.ts, uu);
      if (pr.unknownModel != null) unknown.add(pr.unknownModel);
      byModel.set(model, (byModel.get(model) || 0) + (u.total_tokens || 0));
    }
    if (pr.confidence === "n/a") unpriced++; else priced++;
    for (const k in costParts) costParts[k] += pr.parts[k];

    const key = r.turnId ?? "";
    let g = turns.get(key);
    if (!g) turns.set(key, g = { usd: 0, apiCalls: 0, tokens: ZERO_TOKENS(), costParts: ZERO_PARTS() });
    g.usd += pr.usd; g.apiCalls++;
    g.tokens.input += uu.in; g.tokens.cacheRead += uu.cr;
    g.tokens.output += uu.out; g.tokens.cacheWrite5m += uu.c5;
    for (const k in g.costParts) g.costParts[k] += pr.parts[k];

    calls.push({ id: r.id ?? null, ts: r.ts ?? null, cost: pr.usd, model,
                 tokens: { in: uu.in, out: uu.out, cr: uu.cr, cw: uu.c5 },
                 costParts: pr.parts, turnId: r.turnId ?? null });
  }
  calls.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // The rounding point, and the only float arithmetic this provider pins: each
  // TURN's raw sum is rounded to 4 decimals, and the session total is the sum of
  // those. Rounding only at the node leaves the reference thread's exact
  // $0.51175 an exact 4-decimal tie decided by float grouping order alone.
  const turnCost = {};
  let costOwn = 0;
  for (const [k, g] of turns) {
    g.usd = +g.usd.toFixed(4);
    costOwn += g.usd;
    turnCost[k] = g;
  }

  // K1/M11 self-check: the per-record sums must equal the running total the last
  // record carries. Compared on the RAW sums, never on the post-subtraction node
  // figures -- thread_token_usage.input_tokens is the raw input total, so
  // comparing it against tokens.input fires on every healthy thread. Never fails
  // the build; the K1 sum stands and the discrepancy is said once.
  const last = recs.length ? recs[recs.length - 1].tot : null;
  if (last) {
    const off = ["input_tokens", "cached_input_tokens", "output_tokens", "cache_write_input_tokens"]
      .filter(k => (last[k] ?? 0) !== raw[k]);
    if (off.length)
      warn(`${path.basename(file)}: per-record usage sums disagree with the last record's ` +
           `thread_token_usage on ${off.join(", ")}; keeping the per-record sums`);
  }

  return {
    tokens, apiCalls: ids.size,
    models: models.sort((a, b) => (byModel.get(b) || 0) - (byModel.get(a) || 0)),
    efforts, costOwn, costParts, unknownModels: [...unknown],
    costConfidence: priced === 0 ? "n/a" : unpriced ? "partial" : "computed",
    turnCost, calls,
  };
}

// ---------------------------------------------------------------------------
// Incrementality: the rollout has no incremental parser, and server.mjs rebuilds
// every tree every --interval seconds. One entry per thread id, REPLACED when
// updated_at_ms moves, so the map is bounded exactly the way the claude
// provider's path-keyed parser cache is. What is held is the reader's product,
// never the node graph: a shared graph would alias a tree that render.mjs writes
// onto, and would keep a stale child under a spawn parent the child alone moved.
const cacheKey = id => `codex:st:${id}`;

function rollFor(cache, id, updatedMs, storedPath) {
  const key = cacheKey(id);
  const hit = cache && cache.get(key);
  if (hit && hit.updatedMs === updatedMs) return hit.roll;
  const file = resolveRollout(storedPath);
  const roll = file ? readRollout(file) : null;
  if (cache) cache.set(key, { updatedMs, roll });
  return roll;
}

// ---------------------------------------------------------------------------
/** All top-level sessions: [{provider,id,project,path,mtimeMs,size}] */
export function discover() {
  // Existence gate, deliberately silent: "Codex was never installed" is not a
  // fault, and nothing may touch node:sqlite before this returns.
  if (!fs.existsSync(statePath())) return [];
  const h = open(statePath());
  const threads = rows(h, "select id, rollout_path, cwd, created_at, updated_at, updated_at_ms from threads");
  if (!threads) return [];

  // A thread that is the child of a resolvable spawn edge belongs inside its
  // parent's tree, not at the top level -- the same convention that keeps a
  // Claude harness subagent's own file out of claude.discover(). An ORPHANED
  // edge (parent not in threads) must NOT hide the child: it would vanish from
  // the list and become unreachable in the UI with nothing explaining why.
  // threads.archived deliberately does not filter: atlas audits what is on disk,
  // and the Claude side has no archive concept to be consistent with.
  const known = new Set(threads.map(t => t.id));
  const nested = new Set();
  for (const e of rows(h, "select parent_thread_id, child_thread_id from thread_spawn_edges") || [])
    if (known.has(e.parent_thread_id) && known.has(e.child_thread_id)) nested.add(e.child_thread_id);

  const out = [];
  for (const t of threads) {
    if (nested.has(t.id)) continue;
    const p = resolveRollout(t.rollout_path);
    let size = 0;
    if (p) { try { size = fs.statSync(p).size; } catch { size = 0; } }
    out.push({ provider: name, id: t.id, project: String(t.cwd ?? "").replace(/\//g, "-"),
               path: p, mtimeMs: t.updated_at_ms ?? t.updated_at * 1000, size });
  }
  return out;
}

/** Codex sessions are not files; no path argument ever names one. */
export function refFromPath() { return null; }

// ---------------------------------------------------------------------------
/**
 * Build the agent tree for one Codex thread.
 * cache: shared across providers, so every key written here is `codex:`-prefixed
 * (claude's keys are absolute paths, which cannot collide with that).
 */
export function buildTree(ref, cache = new Map()) {
  const state = statePath();
  const h = fs.existsSync(state) ? open(state) : null;
  // Single-session paths fail loudly rather than serving a hollow session; the
  // bulk loops in cli.mjs/server.mjs isolate per ref so one bad thread cannot
  // take the others down with it.
  if (!h) throw new Error(`codex store unavailable at ${state}`);

  const hist = fs.existsSync(historyPath()) ? open(historyPath()) : null;
  const thread = id => {
    const r = rows(h, "select * from threads where id = ?", id);
    return r && r.length ? r[0] : null;
  };
  const kidsOf = id =>
    (rows(h, "select child_thread_id from thread_spawn_edges where parent_thread_id = ?", id) || [])
      .map(e => e.child_thread_id);

  const build = (id, via, ancestors) => {
    const t = thread(id);
    if (!t) return null;
    // Cycle guard: a self- or mutual-edge must not recurse forever.
    ancestors.add(id);
    const children = [];
    for (const kid of kidsOf(id)) {
      if (ancestors.has(kid)) continue;
      // "spawn", never "cli" (which means "detected via a Bash shell-out in a
      // Claude transcript" and drives the [CLI:codex] badge) and never "harness"
      // (Claude's .meta.json sidecar mechanism). A native Codex->Codex link is
      // its own provenance, and via !== "root" already gives it the right
      // human-effort gating: a spawn child's opening prompt is its parent's errand.
      const c = build(kid, "spawn", ancestors);
      if (c) children.push(c);
    }
    ancestors.delete(id);

    const createdMs = t.created_at_ms ?? t.created_at * 1000;
    const updatedMs = t.updated_at_ms ?? t.updated_at * 1000;
    const roll = rollFor(cache, id, updatedMs, t.rollout_path);
    const st = synth(t, roll, createdMs, updatedMs, hist);
    const extra = { provider: name };
    // The provider's own aggregate, set ONLY when there is no real breakdown to
    // contradict. threads.tokens_used is NOT the session total: it is the LAST
    // response's total_tokens -- Codex's context-occupancy figure, reset by
    // compaction (20,346 against a real cumulative of 251,032 on one thread
    // here). It must never be arithmetic input to a dollar figure.
    if (!roll && t.tokens_used) extra.reported = { tokensUsed: t.tokens_used };
    const node = finish("main", "(session)", id, via, st, children, extra, null);
    if (st.identity.agentName) node.agent = st.identity.agentName;
    else if (st.identity.customTitle) node.agent = st.identity.customTitle;
    return node;
  };

  const t = build(ref.id, "root", new Set());
  if (!t) throw new Error(`no codex thread '${ref.id}'`);
  return t;
}

// ---------------------------------------------------------------------------
// The aggregates()-shaped object finish() reads (parse.mjs:387-420) -- the same
// technique the transcript-detected codex leaf already uses. Composed fresh on
// every call, out of the memoised reader product.
function synth(t, roll, createdMs, updatedMs, hist) {
  const turnRows = hist
    ? rows(hist, "select turn_id, started_at, completed_at from thread_turns" +
                 " where thread_id = ? order by rollout_ordinal", t.id) || []
    : [];                                     // legacy history_mode, or no store: no turns
  const items = hist
    ? rows(hist, "select turn_id, item_type, count(*) c from thread_items" +
                 " where thread_id = ? group by turn_id, item_type", t.id) || []
    : [];

  const tools = new Map();                    // turn_id -> {type: count}
  const humanTurns = new Set();
  let userMsgs = 0;
  for (const r of items) {
    noteItemType(r.item_type);
    if (r.item_type === "userMessage") { userMsgs += r.c; humanTurns.add(r.turn_id); }
    if (!TOOL_ITEMS.has(r.item_type)) continue;
    let m = tools.get(r.turn_id);
    if (!m) tools.set(r.turn_id, m = {});
    m[r.item_type] = (m[r.item_type] || 0) + r.c;
  }
  const hasUser = !!t.has_user_event;

  const turns = turnRows.map((r, i) => {
    const g = roll ? roll.turnCost[r.turn_id] : null;
    return {
      ordinal: i + 1,
      // These two columns are SECONDS, not milliseconds.
      start: r.started_at == null ? null : new Date(r.started_at * 1000).toISOString(),
      end: r.completed_at == null ? null : new Date(r.completed_at * 1000).toISOString(),
      apiCalls: g ? g.apiCalls : 0,
      cost: g ? g.usd : 0,
      tokens: g ? { ...g.tokens } : ZERO_TOKENS(),
      costParts: g ? { ...g.costParts } : ZERO_PARTS(),
      skills: [],
      human: hasUser && humanTurns.has(r.turn_id),
      decisions: 0,
      subagents: [],                          // finish() fills it
      tools: tools.get(r.turn_id) || {},
    };
  });

  const openers = new Set();                  // first call of each human turn
  const calls = (roll ? roll.calls : []).map(k => {
    const opens = k.turnId != null && hasUser && humanTurns.has(k.turnId) && !openers.has(k.turnId);
    if (opens) openers.add(k.turnId);
    return { id: k.id, ts: k.ts, cost: k.cost, model: k.model,
             tokens: { ...k.tokens }, costParts: { ...k.costParts },
             acts: [],                        // Codex records no per-response action list
             opensHuman: opens, gates: 0 };
  });

  const identity = {};
  if (t.agent_nickname != null) identity.agentName = t.agent_nickname;
  if (t.name != null) identity.customTitle = t.name;

  return {
    // Ranked by the tokens each model actually burned, never threads.model --
    // that is one last-value column and it over-prices a two-model thread by
    // ~47%. On the degraded path there is nothing else, and cost is n/a with
    // zero tokens there, so it cannot mislead a dollar figure; the column is
    // nullable and [null] would crash shortModel(), hence the guard.
    model: roll ? roll.models : (t.model == null ? [] : [t.model]),
    // Never threads.reasoning_effort: one last-value column cannot carry a
    // per-turn set, and it is NULL on most rows besides.
    effort: roll ? roll.efforts : [],
    start: new Date(createdMs).toISOString(),
    end: new Date(updatedMs).toISOString(),
    durationS: Math.round((updatedMs - createdMs) / 1000),
    // Distinct response_id, never back-filled from thread_turns.
    apiCalls: roll ? roll.apiCalls : 0,
    userMsgs,
    humanMsgs: hasUser ? [...humanTurns].length : 0,
    decisions: 0, interactions: [],
    tokens: roll ? { ...roll.tokens } : ZERO_TOKENS(),
    costOwn: roll ? roll.costOwn : 0,
    costParts: roll ? { ...roll.costParts } : ZERO_PARTS(),
    costConfidence: roll ? roll.costConfidence : "n/a",
    unknownModels: roll ? [...roll.unknownModels] : [],
    // threads.title runs to 700+ characters on this host; first_user_message is
    // the real opening prompt. Codex has no summary, and threads.preview is only
    // a truncation of the same prompt, so claiming one would be a lie -- describe()
    // already falls back to firstPrompt.
    firstPrompt: t.first_user_message || null,
    summary: null,
    skills: [],
    branch: t.git_branch ?? null,
    cwd: t.cwd ?? null,
    version: t.cli_version ?? null,
    // Codex has git_origin_url, but a Claude `repo` is {repo, prNumber, prUrl}
    // and two of those three would be invented.
    repo: null,
    identity,
    turns,
    turnByToolUse: null,                      // Codex records no tool_use -> turn join
    calls,
  };
}
