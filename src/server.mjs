// agent-atlas web server. Zero dependencies, no outbound network.
// Background scan every --interval seconds: stat-based change detection,
// incremental byte-offset parsing (see parse.mjs). Live sessions simply keep
// growing; every page shows cost-so-far and auto-refreshes while live.
import http from "node:http";
import { URL } from "node:url";
import * as providers from "./providers/index.mjs";
import { describe, workspace } from "./providers/index.mjs";
import { treeHTML, indexHTML, subtreeTotals, agentMs, perAgent, money } from "./render.mjs";

const LIVE_MS = 120_000;

export function serve({ host = "127.0.0.1", port = 4747, intervalS = 10, token = null } = {}) {
  const cache = new Map();          // path -> SessionFileParser (incremental)
  let sessions = [];                // discover() snapshot
  let rows = [];                    // index rows (rebuilt on scan)
  const countAgents = t => t.children.reduce((a, c) => a + 1 + countAgents(c), 0);

  function scan() {
    try {
      sessions = providers.discover().sort((a, b) => b.mtimeMs - a.mtimeMs);
      rows = sessions.map(s => {
        // Per-ref fault isolation: a session that cannot be built is dropped
        // with one line naming it, and the index still rebuilds. The outer
        // catch below only covers discover() now -- it used to freeze the whole
        // index at its previous value ([] on the first scan) for one bad ref.
        let t;
        try { t = providers.buildTree(s, cache); }   // incremental: only new bytes parsed
        catch (e) { console.error("[scan] " + s.id + ": " + e.message); return null; }
        const d = describe(t);
        const tot = subtreeTotals(t).get(t).tot;
        return { id: s.id, project: s.project.replace(/^-/, ""), path: s.path,
          name: t.identity?.agentName || t.identity?.customTitle || "",
          title: d.title, subtitle: d.subtitle,
          desc: (t.firstPrompt || "").slice(0, 220),
          start: t.start, durationS: t.durationS,
          live: Date.now() - s.mtimeMs < LIVE_MS,
          agents: countAgents(t), apiCalls: t.apiCalls,
          // copied straight from the node: the provider is the only place the
          // three human-effort values are computed
          humanMsgs: t.humanMsgs,
          costPerHumanMsg: t.costPerHumanMsg, callsPerHumanMsg: t.callsPerHumanMsg,
          agentMs: agentMs(t),
          byAgent: perAgent(t),
          model: t.model[0] || null,
          workspace: workspace(t), version: t.version,
          tokens: tot.t, tokenCost: tot.d,
          cost: t.cost.total };
      }).filter(Boolean);
    } catch (e) { console.error("[scan]", e.message); }
  }
  scan();
  setInterval(scan, intervalS * 1000).unref?.();

  const tokenQS = token ? `?t=${token}` : "";
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (token && u.searchParams.get("t") !== token) {
      res.writeHead(403).end("forbidden"); return;
    }
    const send = (code, type, body) =>
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(body);
    const json = o => send(200, "application/json", JSON.stringify(o, null, 1));
    try {
      if (u.pathname === "/") return send(200, "text/html", indexHTML(rows, { tokenQS }));
      if (u.pathname === "/api/sessions") return json(rows);
      let m = u.pathname.match(/^\/(api\/tree|session)\/([0-9a-f-]+)$/);
      if (m) {
        // An exact id wins over any prefix match on an earlier element: .find()
        // with an either-or predicate returns whichever element matches first,
        // and two providers sharing one id space makes that reachable (every
        // Codex id here shares a 4-char prefix, several share 8).
        const s = sessions.find(x => x.id === m[2]) || sessions.find(x => x.id.startsWith(m[2]));
        if (!s) return send(404, "text/plain", "unknown session");
        const t = providers.buildTree(s, cache);
        const live = Date.now() - s.mtimeMs < LIVE_MS;
        if (m[1] === "api/tree") return json(t);
        return send(200, "text/html", treeHTML(t, {
          title: `${money(t.cost.total)} · ${s.project.replace(/^-/, "")}`,
          describe: describe(t), workspace: workspace(t),
          live, backHref: "/" + tokenQS, refresh: live ? 10 : 0 }));
      }
      if (u.pathname === "/healthz") return send(200, "text/plain", "ok");
      send(404, "text/plain", "not found");
    } catch (e) { send(500, "text/plain", "error: " + e.message); }
  });
  srv.listen(port, host, () =>
    console.log(`agent-atlas listening on http://${host}:${port}/${tokenQS}  (scan every ${intervalS}s, ${sessions.length} sessions)`));
  return srv;
}
