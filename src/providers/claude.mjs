// Claude Code provider adapter.
// Sessions live in ~/.claude/projects/<project>/<uuid>.jsonl ; harness subagents
// in <uuid>/subagents/agent-*.jsonl with .meta.json sidecars (agentType,
// description, toolUseId, parentAgentId, spawnDepth); CLI-launched children are
// declared by whoever launches them in <uuid>/launches.jsonl (see README).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionFileParser } from "../parse.mjs";
import { ZERO_PARTS } from "../prices.mjs";

export const name = "claude";
export const root = () =>
  process.env.AGENT_ATLAS_CLAUDE_ROOT || path.join(os.homedir(), ".claude", "projects");

/** All top-level sessions: [{provider,id,project,path,mtimeMs,size}] */
export function discover() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(root()); } catch { return out; }
  for (const proj of projects) {
    const dir = path.join(root(), proj);
    let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      const p = path.join(dir, e);
      let st; try { st = fs.statSync(p); } catch { continue; }
      out.push({ provider: name, id: e.slice(0, -6), project: proj,
                 path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

const sessionDir = f => f.replace(/\.jsonl$/, "");

function readMetas(f) {
  const d = path.join(sessionDir(f), "subagents"); const out = [];
  if (!fs.existsSync(d)) return out;
  for (const n of fs.readdirSync(d)) {
    if (!n.endsWith(".meta.json")) continue;
    try {
      out.push({ id: n.slice(6, -10),
        meta: JSON.parse(fs.readFileSync(path.join(d, n), "utf8")),
        jsonl: path.join(d, n.replace(".meta.json", ".jsonl")) });
    } catch { /* half-written sidecar on a live session: next pass */ }
  }
  return out;
}

function readLaunches(f) {
  const p = path.join(sessionDir(f), "launches.jsonl");
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const l of fs.readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial trailing line */ }
  }
  return out;
}

/**
 * Build the full agent tree for a session file.
 * cache: Map<path, SessionFileParser> shared across calls -> incremental parsing.
 */
export function buildTree(sessionPath, cache = new Map()) {
  const parserFor = p => {
    let ps = cache.get(p);
    if (!ps) { ps = new SessionFileParser(p); cache.set(p, ps); }
    ps.update();
    return ps;
  };

  function node(agent, description, agentId, file, via, extra) {
    const exists = fs.existsSync(file);
    const st = exists ? parserFor(file).aggregates() : null;
    const metas = exists ? readMetas(file) : [];
    const launches = exists ? readLaunches(file) : [];
    const children = [];
    // harness subagents (depth-1 roots of this file; deeper via parentAgentId)
    const attach = (parentKey) => metas
      .filter(m => (parentKey === null ? m.meta.spawnDepth === 1 : m.meta.parentAgentId === parentKey));
    const sub = (m) => {
      const s = fs.existsSync(m.jsonl) ? parserFor(m.jsonl).aggregates() : null;
      const kids = attach(m.id).map(sub);
      for (const l of launches.filter(x => (x.parentAgent || null) === m.id)) kids.push(graft(l));
      return finish(m.meta.agentType, m.meta.description, m.id, "harness", s, kids, {});
    };
    for (const m of attach(null)) children.push(sub(m));
    for (const l of launches.filter(x => !x.parentAgent)) children.push(graft(l));
    return finish(agent, description, agentId, via, st, children, extra || {});
  }

  function graft(l) {
    const extra = { phase: l.phase, round: l.round, reported: l.reported ?? (l.costUsd != null ? { costUsd: l.costUsd } : undefined) };
    if ((l.provider || "claude") === "claude" && l.childTranscript)
      return { ...node(l.agent, l.description, l.childSession, l.childTranscript, "cli", extra) };
    // non-claude or transcript-less launch: leaf from ledger data only
    return finish(l.agent, l.description, l.childSession || null, "cli", {
      model: l.model ? [l.model] : [], effort: [], start: l.startedAt || null,
      end: l.endedAt || null,
      durationS: l.startedAt && l.endedAt ? Math.round((new Date(l.endedAt) - new Date(l.startedAt)) / 1000) : null,
      apiCalls: 0, userMsgs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      costOwn: l.reported?.costUsd ?? l.costUsd ?? 0, costParts: ZERO_PARTS(),
      costConfidence: (l.reported?.costUsd ?? l.costUsd) != null ? "reported" : "n/a",
      unknownModels: [], identity: {},
    }, [], { ...extra, provider: l.provider || "claude" });
  }

  function finish(agent, description, agentId, via, st, children, extra) {
    children.sort((a, b) => ((a.start || "") < (b.start || "") ? -1 : 1));
    const childUsd = children.reduce((a, c) => a + c.cost.total, 0);
    const own = st ? st.costOwn : 0;
    const conf = st ? st.costConfidence : "n/a";
    // Human effort belongs to the session a person typed into: a subagent's
    // "user message" is its parent's errand, so only a root node keeps the
    // parser's count. This is the single place root-ness is enforced, and the
    // `via` conjunct is what does the work — graft()'s ledger-only leaf passes a
    // truthy synthetic `st` that simply has no humanMsgs key.
    const hm = via === "root" && st ? (st.humanMsgs || 0) : 0;
    const calls = st ? st.apiCalls : 0;
    // total is the rolled-up cost already shown everywhere; calls stay root-only.
    const total = +(own + childUsd).toFixed(4);
    return {
      agent, description, agentId, provider: extra.provider || name, via,
      ...(st ? { model: st.model, effort: st.effort, start: st.start, end: st.end,
                 durationS: st.durationS, apiCalls: st.apiCalls, userMsgs: st.userMsgs,
                 tokens: st.tokens, costParts: st.costParts,
                 identity: st.identity, unknownModels: st.unknownModels,
                 firstPrompt: st.firstPrompt, summary: st.summary,
                 skills: st.skills, branch: st.branch,
                 cwd: st.cwd, version: st.version, repo: st.repo }
             : { model: [], effort: [], start: null, end: null, durationS: null,
                 apiCalls: 0, userMsgs: 0,
                 tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
                 costParts: ZERO_PARTS(),
                 identity: {}, unknownModels: [], skills: [], branch: null,
                 cwd: null, version: null, repo: null }),
      humanMsgs: hm,
      costPerHumanMsg: hm ? +(total / hm).toFixed(4) : null,
      callsPerHumanMsg: hm ? +(calls / hm).toFixed(4) : null,
      ...("phase" in extra && extra.phase !== undefined ? { phase: extra.phase } : {}),
      ...("round" in extra && extra.round !== undefined ? { round: extra.round } : {}),
      ...(extra.reported ? { reported: extra.reported } : {}),
      cost: { own: +own.toFixed(4), children: +childUsd.toFixed(4),
              total, confidence: conf },
      children,
    };
  }

  const base = path.basename(sessionPath, ".jsonl");
  const t = node("main", "(session)", base, sessionPath, "root");
  if (t.identity?.agentName) t.agent = t.identity.agentName;
  else if (t.identity?.customTitle) t.agent = t.identity.customTitle;
  return t;
}

// Paseo checks work out into ~/.paseo/worktrees/<id>/<name>, where the path says
// nothing about which repository it is a worktree of.
const PASEO_WORKTREE = /\/\.paseo\/worktrees\//;
const GH = /github\.com\/([\w.-]+)\/([\w.-]+)/;

/**
 * Where a session ran, named the way a human would name it.
 *
 * The transcript never records a git remote, so the repository is only knowable
 * when the harness logged a PR it opened (`pr-link`) or when the opening prompt
 * cites a GitHub URL. The working directory is the reliable signal and is
 * preferred whenever it carries the project itself; the repository is the
 * fallback for worktree paths, which do not.
 */
export function workspace(t) {
  const cwd = t.cwd || "";
  const fromPR = t.repo?.repo || null;
  const m = (t.firstPrompt || "").match(GH);
  const repo = fromPR || (m ? m[1] + "/" + m[2].replace(/\.git$/, "") : null);
  let label = "", source = null;
  if (cwd.startsWith("/workspace/")) { label = cwd.slice(11); source = "cwd"; }
  else if (PASEO_WORKTREE.test(cwd) && repo) { label = repo; source = fromPR ? "pr" : "prompt"; }
  else if (cwd) {
    // a bare leaf name is often meaningless (/tmp/launcher-study/fan -> "fan"),
    // so keep the parent too — unless it is an opaque worktree id
    const parts = cwd.split("/").filter(Boolean);
    const parent = parts[parts.length - 2] || "";
    label = PASEO_WORKTREE.test(cwd) || !parent ? parts[parts.length - 1]
          : parent + "/" + parts[parts.length - 1];
    source = "dir";
  }
  const branch = t.branch || null;
  // Only linkable when the repository is known at all. Whether the branch still
  // exists on the remote is unknowable from here — checking would mean a network
  // call, and this tool deliberately makes none.
  const branchUrl = repo && branch ? `https://github.com/${repo}/tree/${encodeURIComponent(branch)}` : null;
  return { label, source, cwd, repo, branch, branchUrl };
}

/** Human title + subtitle for a session tree. No external sources: transcript only. */
export function describe(t) {
  let title = null;
  const m = (t.firstPrompt || "").match(
    /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\s*[—–-]*\s*(.*)/);
  if (m) { const it = m[4].split(/\s+ORIGEN:/)[0].replace(/["`]+/g, "").trim();
    title = (m[2] + "#" + m[3] + (it ? " — " + it : "")).slice(0, 110); }
  title = title || t.summary || t.identity?.customTitle || t.identity?.agentName || null;
  if (!title && t.firstPrompt) title = t.firstPrompt.slice(0, 90);
  const subtitle = [ (t.skills || []).slice(0, 6).join(" → "), t.branch ]
    .filter(Boolean).join(" · ");
  return { title: title || "", subtitle };
}