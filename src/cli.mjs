#!/usr/bin/env node
// agent-atlas CLI. Commands: list, tree, export, serve.
import fs from "node:fs";
import * as claude from "./providers/claude.mjs";
import { treeHTML, treeTerminal, fmtDur } from "./render.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : dflt;
};
const LIVE_MS = 120_000;

function resolveSession(ref) {
  if (fs.existsSync(ref)) return ref;
  const hits = claude.discover().filter(s => s.id.startsWith(ref));
  if (hits.length === 1) return hits[0].path;
  if (hits.length === 0) die(`no session matches '${ref}'`);
  die(`ambiguous: ${hits.map(h => h.id.slice(0, 12)).join(", ")}`);
}
const die = m => { console.error("agent-atlas: " + m); process.exit(1); };

if (cmd === "list") {
  const days = +opt("days", 7);
  const cutoff = Date.now() - days * 864e5;
  const all = args.includes("--all");
  const cache = new Map();
  const minCost = +opt("min-cost", 0);
  const sortK = String(opt("sort", "time"));
  const rows = claude.discover()
    .filter(s => all || s.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(s => {
      const t = claude.buildTree(s.path, cache);
      return { id: s.id, project: s.project.replace(/^-/, "").slice(0, 38),
        name: t.identity?.agentName || t.identity?.customTitle || "",
        desc: (t.firstPrompt || "").slice(0, 70),
        start: t.start, durationS: t.durationS, live: Date.now() - s.mtimeMs < LIVE_MS,
        agents: countAgents(t), cost: t.cost.total };
    })
    .filter(r => r.cost >= minCost);
  if (sortK === "cost") rows.sort((a, b) => b.cost - a.cost);
  if (args.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  for (const r of rows)
    console.log([r.live ? "LIVE" : "    ", r.id.slice(0, 8),
      (r.start || "").slice(0, 16).replace("T", " "), fmtDur(r.durationS).padStart(6),
      String(r.agents).padStart(3) + " ag", ("$" + r.cost.toFixed(2)).padStart(9),
      r.name || r.project, r.desc ? "· " + r.desc : ""].join("  "));
  const total = rows.reduce((a, r) => a + r.cost, 0);
  console.log(`\n${rows.length} sessions · total $${total.toFixed(2)} (last ${all ? "∞" : days + "d"})`);
} else if (cmd === "tree" || cmd === "export") {
  const p = resolveSession(args[1] || die("usage: agent-atlas tree <session-id|path>"));
  const t = claude.buildTree(p);
  if (cmd === "export" || args.includes("--html")) {
    const html = treeHTML(t, { title: `${t.agent} · ${t.cost ? "$" + t.cost.total.toFixed(2) : ""}` });
    const out = opt("out", null);
    if (out && out !== true) { fs.writeFileSync(out, html); console.error("wrote " + out); }
    else process.stdout.write(html);
  } else if (args.includes("--json")) console.log(JSON.stringify(t, null, 1));
  else console.log(treeTerminal(t));
} else if (cmd === "serve") {
  const { serve } = await import("./server.mjs");
  serve({ host: String(opt("host", "127.0.0.1")), port: +opt("port", 4747),
          intervalS: +opt("interval", 10), token: opt("token", null) || null });
} else {
  console.log(`agent-atlas — provider-agnostic cost & agent-tree explorer

  agent-atlas list [--days 7 | --all] [--json]
  agent-atlas tree <session-id|path> [--json | --html]
  agent-atlas export <session-id|path> [--out file.html]
  agent-atlas serve [--host 127.0.0.1] [--port 4747] [--interval 10] [--token X]`);
}

function countAgents(t) { return t.children.reduce((a, c) => a + 1 + countAgents(c), 0); }
