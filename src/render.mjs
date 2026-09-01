// Renderers: standalone HTML (expandable tree), index page, terminal tree.
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const usd = n => n > 0 && n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2);
export const fmtDur = s => s == null ? "" :
  s >= 3600 ? (s / 3600).toFixed(1) + "h" : s >= 60 ? Math.round(s / 60) + "m" : s + "s";
const shortModel = ms => ms.map(m => m.replace("claude-", "").replace("-20251001", "")).join("+") || "—";

const CSS = `
body{font:13px/1.6 ui-monospace,SFMono-Regular,monospace;background:#101014;color:#ddd;
 padding:1.5em;max-width:1150px;margin:auto}
a{color:#7ec8ff;text-decoration:none} a:hover{text-decoration:underline}
h2,h3{font-weight:600;color:#eee} .muted{color:#777}
details{margin-left:1.2em;border-left:1px solid #2c2c34;padding-left:.8em}
.leaf{margin-left:2.55em;border-left:1px solid #1c1c22;padding-left:.8em}
summary{cursor:pointer;list-style:"▸ "} details[open]>summary{list-style:"▾ "}
.a{color:#7ec8ff;font-weight:bold}.d{color:#aaa;margin-left:.5em}
.meta{color:#666;margin-left:.6em;font-size:11px}
.c{float:right;color:#ffd479;font-weight:bold}.split{color:#888;font-weight:normal;font-size:11px}
.badge{border-radius:3px;padding:0 .35em;font-size:10px;margin-right:.35em;color:#fff}
.cli{background:#2a7a44}.live{background:#c33;animation:p 1.5s infinite}
.conf-computed{color:#c90;font-size:10px}.conf-reported{color:#09c;font-size:10px}
@keyframes p{50%{opacity:.5}}
table{border-collapse:collapse;width:100%}
td,th{padding:.25em .7em;border-bottom:1px solid #222;text-align:left;white-space:nowrap}
th{color:#888;font-weight:normal} td.r,th.r{text-align:right}
tr:hover td{background:#17171d}`;

export function treeHTML(tree, { title = "", live = false, backHref = null, refresh = 0 } = {}) {
  function render(n, open) {
    const badges = (n.via === "cli" ? `<span class="badge cli">CLI${n.provider !== "claude" ? ":" + esc(n.provider) : ""}</span>` : "");
    const conf = n.cost.confidence === "computed" ? ` <span class=conf-computed>±computed</span>` :
                 n.cost.confidence === "reported" ? ` <span class=conf-reported>reported</span>` : "";
    const pr = n.phase != null ? `<span class=meta>[${esc(n.phase)}${n.round != null ? "/r" + esc(n.round) : ""}]</span>` : "";
    const head = `${badges}<span class=a>${esc(n.agent)}</span> <span class=d>${esc(n.description)}</span>${pr}` +
      `<span class=meta>${esc(shortModel(n.model))} · ${esc(n.effort.join(","))} · ${fmtDur(n.durationS)} · ${n.apiCalls} calls · out ${n.tokens.output.toLocaleString("en")}</span>` +
      `<span class=c>${usd(n.cost.total)}${conf}${n.children.length ? ` <span class=split>(own ${usd(n.cost.own)} + sub ${usd(n.cost.children)})</span>` : ""}</span>`;
    return n.children.length
      ? `<details${open ? " open" : ""}><summary>${head}</summary>${n.children.map(c => render(c, false)).join("")}</details>`
      : `<div class=leaf>${head}</div>`;
  }
  return `<!doctype html><meta charset=utf-8><title>${esc(title)}</title>
${refresh ? `<meta http-equiv=refresh content=${refresh}>` : ""}<style>${CSS}</style>
${backHref ? `<p><a href="${esc(backHref)}">← sessions</a></p>` : ""}
<h3>${live ? '<span class="badge live">LIVE</span>' : ""}${esc(title)}</h3>
${render(tree, true)}`;
}

export function indexHTML(rows, { tokenQS = "" } = {}) {
  const tr = rows.map(r => `<tr>
<td>${r.live ? '<span class="badge live">LIVE</span>' : ""}<a href="/session/${esc(r.id)}${tokenQS}">${esc(r.id.slice(0, 8))}</a></td>
<td>${esc(r.name || "")}</td><td class=muted>${esc(r.project)}</td>
<td>${esc((r.start || "").slice(0, 16).replace("T", " "))}</td>
<td class=r>${fmtDur(r.durationS)}</td><td class=r>${r.agents}</td>
<td class=r>${r.output.toLocaleString("en")}</td><td class=r><b>${usd(r.cost)}</b></td></tr>`).join("\n");
  return `<!doctype html><meta charset=utf-8><title>agent-atlas</title>
<meta http-equiv=refresh content=30><style>${CSS}</style>
<h2>agent-atlas <span class=muted>· ${rows.length} sessions</span></h2>
<table><tr><th>session</th><th>name</th><th>project</th><th>start</th>
<th class=r>dur</th><th class=r>agents</th><th class=r>tokens out</th><th class=r>cost</th></tr>
${tr}</table>`;
}

export function treeTerminal(tree, width = process.stdout.columns || 120) {
  const out = [];
  function line(n, prefix, childPrefix) {
    const badge = n.via === "cli" ? `[CLI${n.provider !== "claude" ? ":" + n.provider : ""}] ` : "";
    const cost = usd(n.cost.total) +
      (n.children.length ? ` (own ${usd(n.cost.own)} + sub ${usd(n.cost.children)})` : "") +
      (n.cost.confidence === "computed" ? " ±" : n.cost.confidence === "reported" ? " (reported)" : "");
    const meta = `${shortModel(n.model)} ${n.effort.join(",")} ${fmtDur(n.durationS)} ${n.apiCalls}c`;
    let head = `${prefix}${badge}${n.agent} — ${n.description ?? ""}`;
    const tail = `  ${meta}  ${cost}`;
    const room = width - tail.length - 1;
    if (head.length > room) head = head.slice(0, Math.max(room - 1, 10)) + "…";
    out.push(head + " ".repeat(Math.max(room - head.length, 1)) + tail);
    n.children.forEach((c, i) => {
      const lastKid = i === n.children.length - 1;
      line(c, childPrefix + (lastKid ? "└─ " : "├─ "), childPrefix + (lastKid ? "   " : "│  "));
    });
  }
  line(tree, "", "");
  return out.join("\n");
}
