// agent-atlas web server. Zero dependencies, no outbound network.
// Background scan every --interval seconds: stat-based change detection,
// incremental byte-offset parsing (see parse.mjs). Live sessions simply keep
// growing; every page shows cost-so-far and auto-refreshes while live.
import http from "node:http";
import { URL } from "node:url";
import * as claude from "./providers/claude.mjs";
import { treeHTML, indexHTML } from "./render.mjs";

const LIVE_MS = 120_000;

export function serve({ host = "127.0.0.1", port = 4747, intervalS = 10, token = null } = {}) {
  const cache = new Map();          // path -> SessionFileParser (incremental)
  let sessions = [];                // discover() snapshot
  let rows = [];                    // index rows (rebuilt on scan)
  const countAgents = t => t.children.reduce((a, c) => a + 1 + countAgents(c), 0);

  function scan() {
    try {
      sessions = claude.discover().sort((a, b) => b.mtimeMs - a.mtimeMs);
      rows = sessions.map(s => {
        const t = claude.buildTree(s.path, cache);   // incremental: only new bytes parsed
        return { id: s.id, project: s.project.replace(/^-/, ""), path: s.path,
          name: t.identity?.agentName || t.identity?.customTitle || "",
          title: t.summary || t.identity?.customTitle || t.identity?.agentName || "",
          desc: (t.firstPrompt || "").slice(0, 220),
          start: t.start, durationS: t.durationS,
          live: Date.now() - s.mtimeMs < LIVE_MS,
          agents: countAgents(t), apiCalls: t.apiCalls,
          output: t.tokens.output, cost: t.cost.total };
      });
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
        const s = sessions.find(x => x.id === m[2] || x.id.startsWith(m[2]));
        if (!s) return send(404, "text/plain", "unknown session");
        const t = claude.buildTree(s.path, cache);
        const live = Date.now() - s.mtimeMs < LIVE_MS;
        if (m[1] === "api/tree") return json(t);
        return send(200, "text/html", treeHTML(t, {
          title: `${t.agent} · $${t.cost.total.toFixed(2)} · ${s.project.replace(/^-/, "")}`,
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
