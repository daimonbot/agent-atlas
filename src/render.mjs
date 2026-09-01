// Renderers: web index (sortable/filterable), session tree page, standalone
// HTML export, terminal tree. Zero dependencies; client JS is vanilla.
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const usd = n => n > 0 && n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2);
const num = n => (n ?? 0).toLocaleString("en");
export const fmtDur = s => s == null ? "" :
  s >= 3600 ? (s / 3600).toFixed(1) + "h" : s >= 60 ? Math.round(s / 60) + "m" : s + "s";
const kTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n);
const shortModel = ms => ms.map(m => m.replace("claude-", "").replace("-20251001", "")).join("+") || "—";

const CSS = `
:root{--bg:#101014;--panel:#17171d;--line:#26262e;--tx:#d8d8de;--mut:#8a8a94;--dim:#5c5c66;
 --blue:#7ec8ff;--gold:#ffd479;--green:#3fbf6f;--red:#e05252}
*{box-sizing:border-box}
body{font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--tx);
 padding:1.4em;max-width:1280px;margin:auto}
a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
h2,h3{font-weight:600;color:#eee;margin:.2em 0 .6em}
.muted{color:var(--mut)} .dim{color:var(--dim)}
.badge{border-radius:3px;padding:0 .38em;font-size:10px;margin-right:.4em;color:#fff;vertical-align:1px}
.cli{background:#2a7a44}.live{background:var(--red);animation:p 1.5s infinite}
@keyframes p{50%{opacity:.45}}
.conf-computed{color:#c90;font-size:10px}.conf-reported{color:#09c;font-size:10px}
/* ---- index ---- */
.controls{display:flex;gap:.7em;align-items:center;flex-wrap:wrap;background:var(--panel);
 border:1px solid var(--line);border-radius:8px;padding:.6em .9em;margin-bottom:.9em}
.controls input,.controls select{background:var(--bg);color:var(--tx);border:1px solid var(--line);
 border-radius:5px;padding:.3em .5em;font:inherit}
.controls input[type=number]{width:5.5em}
.controls label{color:var(--mut);display:flex;gap:.35em;align-items:center}
#stats{margin-left:auto;color:var(--gold);font-weight:600}
table{border-collapse:collapse;width:100%}
td,th{padding:.34em .6em;border-bottom:1px solid #1d1d24;text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:normal;cursor:pointer;user-select:none;white-space:nowrap;position:sticky;top:0;background:var(--bg)}
th.r,td.r{text-align:right} th .arr{color:var(--gold)}
tr:hover td{background:var(--panel)}
td.task{max-width:520px} .title{color:#eee;font-weight:600}
.desc{color:var(--mut);font-size:12px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
 -webkit-line-clamp:2;-webkit-box-orient:vertical}
td .cost{color:var(--gold);font-weight:700}
/* ---- tree ---- */
.head{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding: .9em 1.1em;margin-bottom:.8em}
.head .title{font-size:15px}
.stats{display:flex;gap:1.6em;flex-wrap:wrap;margin-top:.6em}
.stat b{display:block;color:var(--gold);font-size:15px} .stat span{color:var(--mut);font-size:11px}
.stat.big b{font-size:22px}
.toolbar{display:flex;gap:.5em;margin:.6em 0}
.toolbar button{background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:5px;
 padding:.25em .7em;font:inherit;cursor:pointer} .toolbar button.on{border-color:var(--gold);color:var(--gold)}
details{margin-left:1.15em;border-left:1px solid var(--line);padding-left:.75em}
.leaf{margin-left:2.45em;border-left:1px solid #1c1c22;padding-left:.75em}
summary{cursor:pointer;list-style:"▸ "} details[open]>summary{list-style:"▾ "}
.row{display:flex;align-items:baseline;gap:.5em;padding:.1em .3em;border-radius:4px;
 background:linear-gradient(90deg,rgba(126,200,255,.07) var(--w,0%),transparent var(--w,0%))}
summary .row{display:inline-flex;width:calc(100% - 1.2em)}
.a{color:var(--blue);font-weight:bold;white-space:nowrap}
.d{color:#c9c9d2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:6em}
.chip{color:var(--dim);font-size:11px;white-space:nowrap}
.meta{color:var(--dim);font-size:11px;white-space:nowrap}
.c{color:var(--gold);font-weight:700;white-space:nowrap;margin-left:auto}
.share{color:var(--dim);font-size:11px}
.split{color:var(--mut);font-weight:normal;font-size:11px}`;

// ---------------------------------------------------------------- index page
export function indexHTML(rows, { tokenQS = "" } = {}) {
  const projects = [...new Set(rows.map(r => r.project))].sort();
  const tr = rows.map(r => {
    const title = r.title || r.name || "";
    return `<tr data-cost="${r.cost}" data-start="${esc(r.start || "")}" data-dur="${r.durationS ?? 0}"
 data-agents="${r.agents}" data-calls="${r.apiCalls ?? 0}" data-out="${r.output}" data-live="${r.live ? 1 : 0}"
 data-project="${esc(r.project)}" data-text="${esc(((title + " " + (r.subtitle || "") + " " + (r.desc || "") + " " + r.project + " " + r.id)).toLowerCase())}">
<td>${r.live ? '<span class="badge live">LIVE</span>' : ""}<a href="/session/${esc(r.id)}${tokenQS}">${esc(r.id.slice(0, 8))}</a></td>
<td class=task title="${esc(r.desc || "")}">${title ? `<div class=title>${esc(title)}</div>` : ""}${r.subtitle ? `<div class=desc>${esc(r.subtitle)}</div>` : (r.desc ? `<div class=desc>${esc(r.desc)}</div>` : "")}</td>
<td class=muted>${esc(r.project)}</td>
<td class=dim>${esc((r.start || "").slice(0, 16).replace("T", " "))}</td>
<td class=r>${fmtDur(r.durationS)}</td><td class=r>${r.agents}</td><td class=r>${num(r.apiCalls)}</td>
<td class=r>${num(r.output)}</td><td class=r><span class=cost>${usd(r.cost)}</span></td></tr>`;
  }).join("\n");
  return `<!doctype html><meta charset=utf-8><title>agent-atlas</title>
<meta http-equiv=refresh content=60><style>${CSS}</style>
<h2>agent-atlas</h2>
<div class=controls>
  <input id=q placeholder="filtrar texto…">
  <select id=proj><option value="">todos los proyectos</option>${projects.map(p => `<option>${esc(p)}</option>`).join("")}</select>
  <label>min $ <input id=mincost type=number step=0.05 min=0 value=0.10></label>
  <label><input id=liveonly type=checkbox> solo live</label>
  <span id=stats></span>
</div>
<table id=t><thead><tr>
<th>sesión</th>
<th>tarea</th><th data-k=project data-t=s>proyecto <span class=arr></span></th>
<th data-k=start data-t=s>inicio <span class=arr></span></th><th class=r data-k=dur>dur <span class=arr></span></th>
<th class=r data-k=agents>agentes <span class=arr></span></th><th class=r data-k=calls>calls <span class=arr></span></th>
<th class=r data-k=out>tokens out <span class=arr></span></th><th class=r data-k=cost>coste <span class=arr></span></th>
</tr></thead><tbody>${tr}</tbody></table>
<script>
(function(){
 var tb=document.querySelector('#t tbody');
 var rows=[].slice.call(tb.rows);
 var sortK='start', sortDir=-1;
 function val(r,k){ var v=r.dataset[k]||''; return isNaN(+v)||v===''?v:+v; }
 function apply(){
  var q=document.getElementById('q').value.toLowerCase();
  var pr=document.getElementById('proj').value;
  var mc=parseFloat(document.getElementById('mincost').value)||0;
  var lo=document.getElementById('liveonly').checked;
  var vis=0,cost=0;
  rows.sort(function(a,b){var x=val(a,sortK),y=val(b,sortK);
   return (x<y?-1:x>y?1:0)*sortDir;});
  rows.forEach(function(r){
   var ok=(+r.dataset.cost>=mc)&&(!pr||r.dataset.project===pr)&&(!lo||r.dataset.live==='1')
     &&(!q||r.dataset.text.indexOf(q)>-1);
   r.style.display=ok?'':'none';
   if(ok){vis++;cost+=+r.dataset.cost;tb.appendChild(r);}
  });
  document.getElementById('stats').textContent=vis+' / '+rows.length+' sesiones · $'+cost.toFixed(2);
  document.querySelectorAll('th .arr').forEach(function(e){e.textContent='';});
  var th=document.querySelector('th[data-k="'+sortK+'"] .arr');
  if(th)th.textContent=sortDir<0?'↓':'↑';
 }
 document.querySelectorAll('th[data-k]').forEach(function(th){
  th.addEventListener('click',function(){
   var k=th.dataset.k;
   if(k===sortK)sortDir=-sortDir; else {sortK=k;sortDir=th.dataset.t==='s'?1:-1;}
   apply();
  });});
 ['q','proj','mincost','liveonly'].forEach(function(id){
  var e=document.getElementById(id);
  e.addEventListener('input',apply); e.addEventListener('change',apply);});
 apply();
})();
</script>`;
}

// ----------------------------------------------------------------- tree page
export function treeHTML(tree, opts = {}) {
  const { title = "", live = false, backHref = null, refresh = 0 } = opts;
  function nodeRow(n, parentTotal) {
    const share = parentTotal > 0 ? Math.round(n.cost.total / parentTotal * 100) : 0;
    const badges = (n.via === "cli" ? `<span class="badge cli">CLI${n.provider !== "claude" ? ":" + esc(n.provider) : ""}</span>` : "");
    const conf = n.cost.confidence === "computed" ? ` <span class=conf-computed>±</span>` :
                 n.cost.confidence === "reported" ? ` <span class=conf-reported>rep</span>` : "";
    const pr = n.phase != null ? `<span class=chip>[${esc(n.phase)}${n.round != null ? "/r" + esc(n.round) : ""}]</span>` : "";
    const tip = esc((n.firstPrompt || "").slice(0, 300)) +
      ` — in ${num(n.tokens.input)} · out ${num(n.tokens.output)} · cacheR ${num(n.tokens.cacheRead)} · cacheW ${num(n.tokens.cacheWrite5m + n.tokens.cacheWrite1h)}`;
    return `<span class=row style="--w:${share}%" title="${tip}">${badges}<span class=a>${esc(n.agent)}</span>` +
      `<span class=d>${esc(n.description ?? "")}</span>${pr}` +
      ((n.skills && n.skills.length) ? `<span class=chip>⚙ ${esc(n.skills.slice(0,3).join("→"))}${n.skills.length>3?"…":""}</span>` : "") +
      `<span class=meta>${esc(shortModel(n.model))} · ${esc(n.effort.join(","))} · ${fmtDur(n.durationS)} · ${n.apiCalls}c · out ${kTok(n.tokens.output)}</span>` +
      `<span class=c>${usd(n.cost.total)}${conf}` +
      (parentTotal > 0 ? ` <span class=share>${share}%</span>` : "") +
      (n.children.length ? ` <span class=split>(propio ${usd(n.cost.own)} + hijos ${usd(n.cost.children)})</span>` : "") + `</span>`;
  }
  function render(n, open, parentTotal) {
    const attrs = `data-cost="${n.cost.total}" data-start="${esc(n.start || "")}"`;
    if (!n.children.length) return `<div class=leaf ${attrs}>${nodeRow(n, parentTotal)}</div>`;
    return `<details${open ? " open" : ""} ${attrs}><summary>${nodeRow(n, parentTotal)}</summary>` +
      n.children.map(c => render(c, false, n.cost.total)).join("") + `</details>`;
  }
  const t = tree, tk = t.tokens;
  const nAgents = (function cnt(n) { return n.children.reduce((a, c) => a + 1 + cnt(c), 0); })(t);
  const d = opts.describe || null;
  const sesTitle = (d && d.title) || t.summary || t.identity?.customTitle || t.identity?.agentName || t.agent;
  const sesSub = d ? d.subtitle : "";
  return `<!doctype html><meta charset=utf-8><title>${esc(title || sesTitle)}</title>
${refresh ? `<meta http-equiv=refresh content=${refresh}>` : ""}<style>${CSS}</style>
${backHref ? `<p><a href="${esc(backHref)}">← sesiones</a></p>` : ""}
<div class=head>
 <div class=title>${live ? '<span class="badge live">LIVE</span>' : ""}${esc(sesTitle)} <span class=dim>· ${esc(t.agentId || "")}</span></div>
 ${sesSub ? `<div class=desc style="margin-top:.2em;color:var(--gold)">${esc(sesSub)}</div>` : ""}
 ${t.firstPrompt ? `<div class=desc style="margin-top:.3em">${esc(t.firstPrompt)}</div>` : ""}
 <div class=stats>
  <span class="stat big"><b>${usd(t.cost.total)}</b><span>coste total</span></span>
  <span class=stat><b>${usd(t.cost.own)}</b><span>main (propio)</span></span>
  <span class=stat><b>${usd(t.cost.children)}</b><span>agentes (${nAgents})</span></span>
  <span class=stat><b>${num(tk.output)}</b><span>tokens out</span></span>
  <span class=stat><b>${kTok(tk.cacheRead)}</b><span>cache read</span></span>
  <span class=stat><b>${kTok(tk.cacheWrite5m + tk.cacheWrite1h)}</b><span>cache write</span></span>
  <span class=stat><b>${num(t.apiCalls)}</b><span>llamadas API</span></span>
  <span class=stat><b>${fmtDur(t.durationS)}</b><span>duración</span></span>
  <span class=stat><b>${esc(shortModel(t.model))}</b><span>${esc(t.effort.join(",") || "—")}</span></span>
 </div>
</div>
<div class=toolbar>
 <button id=exp>expandir todo</button><button id=col>plegar todo</button>
 <span class=dim style="align-self:center">· ordenar hijos:</span>
 <button id=sstart class=on>inicio</button><button id=scost>coste</button>
</div>
<div id=tree>${render(t, true, 0)}</div>
<script>
(function(){
 document.getElementById('exp').onclick=function(){document.querySelectorAll('#tree details').forEach(function(d){d.open=true});};
 document.getElementById('col').onclick=function(){document.querySelectorAll('#tree details').forEach(function(d,i){if(i)d.open=false});};
 function sortKids(by){
  document.querySelectorAll('#tree details').forEach(function(d){
   var kids=[].slice.call(d.children).filter(function(e){return e.tagName==='DETAILS'||e.classList.contains('leaf')});
   kids.sort(function(a,b){
    if(by==='cost')return (+b.dataset.cost)-(+a.dataset.cost);
    var x=a.dataset.start||'',y=b.dataset.start||''; return x<y?-1:x>y?1:0;});
   kids.forEach(function(k){d.appendChild(k)});
  });
  document.getElementById('sstart').className=by==='start'?'on':'';
  document.getElementById('scost').className=by==='cost'?'on':'';
 }
 document.getElementById('sstart').onclick=function(){sortKids('start')};
 document.getElementById('scost').onclick=function(){sortKids('cost')};
})();
</script>`;
}

// -------------------------------------------------------------- terminal tree
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
      const last = i === n.children.length - 1;
      line(c, childPrefix + (last ? "└─ " : "├─ "), childPrefix + (last ? "   " : "│  "));
    });
  }
  line(tree, "", "");
  return out.join("\n");
}
