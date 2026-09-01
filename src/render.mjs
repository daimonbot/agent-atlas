// Renderers: web index (sortable/filterable), session tree page, standalone
// HTML export, terminal tree. Zero dependencies; client JS is vanilla.
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const usd = n => n > 0 && n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2);
const num = n => (n ?? 0).toLocaleString("en");
export const fmtDur = s => s == null ? "" :
  s >= 3600 ? (s / 3600).toFixed(1) + "h" : s >= 60 ? Math.round(s / 60) + "m" : s + "s";
const kTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n);
const shortModel = ms => ms.map(m => m.replace("claude-", "").replace("-20251001", "")).join("+") || "—";

/** A filterable picker. The real value lives in a hidden input keyed by `id`,
 *  so callers listen for change on `id` exactly as they did with a <select>. */
const combo = (id, placeholder, opts, width = "15em") =>
  `<div class=combo data-for="${id}"><input class=cq type=text style="width:${width}"` +
  ` placeholder="${esc(placeholder)}" autocomplete=off><input type=hidden id="${id}" value="">` +
  `<div class=copts hidden><div class=copt data-v="">${esc(placeholder)}</div>` +
  opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o];
    return `<div class=copt data-v="${esc(v)}">${esc(l)}</div>`; }).join("") +
  `</div></div>`;

// shared by both pages; inlined into each one's script
const COMBO_JS = `
 [].forEach.call(document.querySelectorAll('.combo'),function(c){
  var q=c.querySelector('.cq'), hid=c.querySelector('input[type=hidden]'),
      list=c.querySelector('.copts'), opts=[].slice.call(c.querySelectorAll('.copt'));
  function label(v){ for(var i=0;i<opts.length;i++) if(opts[i].dataset.v===v) return v?opts[i].textContent:'';
   return v; }
  function filter(){ var s=q.value.trim().toLowerCase();
   opts.forEach(function(o){ o.hidden=!!s&&o.dataset.v!==''&&o.textContent.toLowerCase().indexOf(s)<0; }); }
  function close(){ list.hidden=true; q.value=label(hid.value); }
  function pick(v){ hid.value=v; q.value=label(v); list.hidden=true;
   hid.dispatchEvent(new Event('change',{bubbles:true})); }
  q.addEventListener('focus',function(){ q.select(); list.hidden=false; filter(); });
  q.addEventListener('input',function(){ list.hidden=false; filter(); });
  q.addEventListener('keydown',function(e){
   if(e.key==='Escape'){ close(); q.blur(); }
   if(e.key==='Enter'){ var v=opts.filter(function(o){return !o.hidden});
    if(v.length){ pick(v[0].dataset.v); q.blur(); } }
  });
  list.addEventListener('mousedown',function(e){
   var o=e.target.closest&&e.target.closest('.copt'); if(!o)return;
   e.preventDefault(); pick(o.dataset.v);
  });
  document.addEventListener('click',function(e){ if(!c.contains(e.target)) close(); });
  q.value=label(hid.value);
 });`;

/**
 * Tokens (t) and what those tokens cost (d), per node, as {own, sub, tot}.
 * Computed over a built tree so the parser and the adapter stay put.
 * Returns a Map keyed by node.
 */
export function subtreeTotals(root) {
  const agg = new Map();
  const zero = () => ({ t: { in: 0, out: 0, cr: 0, cw: 0 }, d: { in: 0, out: 0, cr: 0, cw: 0 } });
  (function walk(n) {
    const own = { t: { in: n.tokens.input, out: n.tokens.output, cr: n.tokens.cacheRead,
                       cw: n.tokens.cacheWrite5m + n.tokens.cacheWrite1h },
                  d: { ...(n.costParts || { in: 0, out: 0, cr: 0, cw: 0 }) } };
    const sub = zero();
    for (const c of n.children) { const a = walk(c);
      for (const k in sub.t) { sub.t[k] += a.tot.t[k]; sub.d[k] += a.tot.d[k]; } }
    const tot = zero();
    for (const k in tot.t) { tot.t[k] = own.t[k] + sub.t[k]; tot.d[k] = own.d[k] + sub.d[k]; }
    const a = { own, sub, tot }; agg.set(n, a); return a;
  })(root);
  return agg;
}

const CSS = `
:root{--bg:#f2f2f0;--card:#fcfcfb;--line:#dedddb;--line2:#ececea;--tx:#0b0b0b;--mut:#52514e;--dim:#8a8985;
 --acc:#2a78d6;--accbg:#eaf2fc;--red:#e34948;--redbg:#fdeded;--amber:#eda100;--bar:rgba(42,120,214,.10);
 --s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100}
*{box-sizing:border-box}
body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
 background:var(--bg);color:var(--tx);padding:1.6em;max-width:1280px;margin:auto;-webkit-font-smoothing:antialiased}
a{color:var(--acc);text-decoration:none} a:hover{text-decoration:underline}
h2,h3{font-weight:650;letter-spacing:-.01em;margin:.1em 0 .7em}
.muted{color:var(--mut)} .dim{color:var(--dim)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.badge{display:inline-block;border-radius:999px;padding:.15em .55em;font-size:10px;font-weight:650;
 letter-spacing:.02em;margin-right:.45em;vertical-align:1px;white-space:nowrap}
.live{background:var(--redbg);color:var(--red)} .live::before{content:"●";font-size:8px;margin-right:.3em;animation:p 1.6s infinite}
.done{background:#ececeb;color:var(--dim)}
.cli{background:var(--accbg);color:var(--acc)}
@keyframes p{50%{opacity:.3}}
.conf-computed{color:var(--amber);font-size:10px}.conf-reported{color:var(--acc);font-size:10px}
.chip{display:inline-block;border-radius:5px;padding:.05em .4em;font-size:10.5px;background:#efefed;
 color:var(--mut);margin-left:.35em;white-space:nowrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
 box-shadow:0 1px 2px rgba(11,11,11,.05);overflow:hidden}
/* ---- shared table ---- */
table{border-collapse:collapse;width:100%}
th{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);
 padding:.8em .75em;border-bottom:1.5px solid var(--line);background:#f7f7f5;text-align:left;
 white-space:nowrap;position:sticky;top:0;z-index:2}
th.s{cursor:pointer;user-select:none} th.s:hover{color:var(--tx)}
th .arr{color:#bcbbb7;font-size:9px;margin-left:.25em} th.on{color:var(--tx)} th.on .arr{color:var(--acc)}
td{padding:.6em .75em;border-bottom:1px solid var(--line2);white-space:nowrap;
 font-variant-numeric:tabular-nums}          /* tabular only in columns of numbers */
th.r,td.r{text-align:right}
tbody tr:hover>td{background:#f6f6f4}
td.money{font-weight:700}
.zero{color:#c9c8c4}
.desc{color:var(--mut);font-size:12px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
 -webkit-line-clamp:2;-webkit-box-orient:vertical}
/* ---- page header ---- */
body.tree{max-width:none}
.head{margin-bottom:1em}
.head h1{font-size:20px;font-weight:650;letter-spacing:-.015em;margin:.1em 0 .5em;max-width:100ch}
.head .sub{color:var(--mut);font-size:11.5px}
.head .idline{color:var(--dim);font-size:11.5px}
.badges{display:flex;gap:.4em;flex-wrap:wrap;align-items:center}
.badges .badge{background:var(--card);border:1px solid var(--line);color:var(--mut);
 border-radius:7px;padding:.25em .55em;font-size:11.5px;font-weight:500;margin:0}
.badges .badge.st{font-weight:650}
.badges .badge.on-live{background:var(--redbg);border-color:#f7c9c9;color:var(--red)}
.badges a.badge.link{color:var(--acc);border-color:#c9dcf5}
.badges a.badge.link:hover{background:var(--accbg);text-decoration:none}
.prompt{color:var(--mut);font-size:12px;margin-top:.75em;max-width:100ch;line-height:1.55}
details.prompt>summary{cursor:pointer;list-style:none}
details.prompt>summary::-webkit-details-marker{display:none}
details.prompt .t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
details.prompt[open] .t{display:block}
details.prompt>summary::after{content:"show full prompt ▾";display:block;margin-top:.25em;
 color:var(--acc);font-size:11px;font-weight:600}
details.prompt[open]>summary::after{content:"show less ▴"}
/* ---- dashboard tiles ---- */
.dash{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:.7em;margin:.9em 0 1.1em}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.8em .9em;
 box-shadow:0 1px 2px rgba(11,11,11,.05)}
.tile .lbl{display:block;color:var(--mut);font-size:11px;margin-bottom:.3em}
.tile b{display:block;font-size:22px;font-weight:650;letter-spacing:-.015em;line-height:1.15}
.tile .sub{display:block;color:var(--dim);font-size:11px;margin-top:.2em}
.tile.lead{border-color:#b9d4f4;background:linear-gradient(180deg,#f4f9ff,var(--card))}
.tile.lead b{font-size:30px}
/* ---- agent table ---- */
.toolbar{display:flex;gap:.4em;margin:0 0 .7em;align-items:center;flex-wrap:wrap}
.toolbar input,.toolbar select{background:var(--card);color:var(--tx);border:1px solid var(--line);
 border-radius:7px;padding:.35em .5em;font:inherit;font-size:12px;outline:none}
.toolbar label{color:var(--mut);display:flex;gap:.4em;align-items:center;font-size:12px}
.toolbar input[type=number]{width:5em}
.toolbar input[type=number]:disabled{color:var(--dim);background:#f4f4f2}
.toolbar input[type=checkbox]{accent-color:var(--acc);margin:0}
.combo{position:relative;display:inline-block}
.copts{position:absolute;z-index:20;top:calc(100% + 4px);left:0;min-width:100%;max-height:17em;
 overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:.25em;
 box-shadow:0 8px 24px rgba(11,11,11,.13)}
.copt{padding:.38em .55em;border-radius:6px;cursor:pointer;white-space:nowrap;font-size:12px}
.copt:hover{background:var(--accbg);color:var(--acc)}
.copt[hidden]{display:none}
.toolbar input:focus,.toolbar select:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--accbg)}
#twrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px;
 box-shadow:0 1px 2px rgba(11,11,11,.05)}
.tt td{padding:.55em .75em;vertical-align:top}
.tt td.twc{width:30px;padding:.55em 0 .55em .7em;vertical-align:middle;cursor:pointer}
.tt th.twc{width:30px;padding-left:.7em;padding-right:0}
.tt tr[data-depth="0"]>td{background:#f7f7f5}
.tt td.ag{background:linear-gradient(90deg,var(--bar) var(--w,0%),transparent var(--w,0%))}
.agl{display:flex;align-items:baseline;gap:.1em}
.tw{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;
 color:var(--dim);font-size:9px;border:1px solid transparent}
tr[data-leaf="1"] .tw{visibility:hidden}
tr[data-open="1"]>td .tw::before{content:"▼"} tr[data-open="0"]>td .tw::before{content:"▶"}
tr:not([data-leaf="1"])>td.ag{cursor:pointer}
tr:not([data-leaf="1"]):hover .tw{background:#fff;border-color:var(--line);color:var(--mut)}
tr:not([data-leaf="1"])>td.twc:hover .tw{background:var(--accbg);border-color:#b9d4f4;color:var(--acc)}
.tt .a{font-weight:650;color:var(--tx)}
.tt td.ag a{font-weight:650;color:var(--tx)} .tt td.ag a:hover{color:var(--acc)}
.tt td.proj .m1,.tt td.proj .m2{max-width:20ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tt .sh{color:var(--dim);font-size:10px;margin-left:.45em;font-weight:400}
.agl{max-width:52ch}
.agl>a,.agl>.a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.agd{color:var(--mut);font-size:11.5px;margin-top:.15em;max-width:52ch;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap}
.m1{color:var(--tx)} .m2{color:var(--dim);font-size:11px;margin-top:.15em}
.usd{display:block;color:var(--dim);font-size:11px;margin-top:.1em;font-weight:400}
/* a real table inside the expanded row, headers and all */
.tt td.nest{padding:.7em 1em 1.1em 2.6em;background:#f7f7f5;border-bottom:1px solid var(--line2)}
.nestbox{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--card);
 box-shadow:0 1px 2px rgba(11,11,11,.04)}
.nestlbl{color:var(--mut);font-size:10px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;
 padding:.65em .85em;background:#f7f7f5;border-bottom:1px solid var(--line)}
table.sub-tt td{padding:.55em .75em} table.sub-tt th{padding:.7em .75em}
table.sub-tt th{position:static}
table.sub-tt tr[data-depth]>td{background:none}
.legend{color:var(--dim);font-size:11px}
/* narrower viewports: tighten the two elastic columns and the gutters before
   falling back to the horizontal scroll #twrap still provides */
@media (max-width:1500px){
 .agl,.agd{max-width:38ch} .tt td.proj .m1,.tt td.proj .m2{max-width:16ch}
}
@media (max-width:1200px){
 body{padding:.9em}
 .agl,.agd{max-width:26ch} .tt td.proj .m1,.tt td.proj .m2{max-width:13ch}
 .tt td,.tt th{padding-left:.5em;padding-right:.5em}
 .tt td.nest{padding-left:1.2em}
}`;

// ---------------------------------------------------------------- index page
// Same shape as the session page: stat tiles over a sortable table, one row per
// session. The tiles report whatever the filters left visible, so narrowing to
// a project or a day answers "what did that cost" without leaving the page.
export function indexHTML(rows, { tokenQS = "" } = {}) {
  const ws = r => r.workspace || { label: "", branch: null, cwd: "" };
  const projects = [...new Set(rows.map(r => ws(r).label).filter(Boolean))].sort();
  const models = [...new Set(rows.map(r => r.model).filter(Boolean))].sort();
  const METRICS = [["in", "in"], ["out", "out"], ["cr", "cache read"], ["cw", "cache write"]];

  // header: [label, sortable, numeric, extra class]
  const COLS = [
    ["status", 1, 0, "l"], ["session", 1, 0, "l"], ["project", 1, 0, "l"],
    ["started", 1, 0, "l"], ["dur", 1, 1, "r"], ["agents", 1, 1, "r"], ["calls", 1, 1, "r"],
    ...METRICS.map(([, l]) => [l, 1, 1, "r"]), ["cost", 1, 1, "r"],
  ];
  const START_COL = 3;
  const head = COLS.map(([label, sortable, numeric, cls], i) =>
    `<th class="${cls}${sortable ? " s" : ""}"${sortable ? ` data-c="${i}" data-n="${numeric}"` : ""}>` +
    `${esc(label)}${sortable ? `<span class=arr></span>` : ""}</th>`).join("");

  const sum = { cost: 0, agents: 0, calls: 0, t: { in: 0, out: 0, cr: 0, cw: 0 },
                d: { in: 0, out: 0, cr: 0, cw: 0 } };
  for (const r of rows) {
    sum.cost += r.cost; sum.agents += r.agents; sum.calls += r.apiCalls || 0;
    for (const [m] of METRICS) { sum.t[m] += (r.tokens || {})[m] || 0;
                                 sum.d[m] += (r.tokenCost || {})[m] || 0; }
  }
  const costs = rows.map(r => r.cost).sort((a, b) => a - b);
  const median = costs.length ? costs[costs.length >> 1] : 0;

  const tr = rows.map(r => {
    const title = r.title || r.name || r.id.slice(0, 8);
    const tk = r.tokens || { in: 0, out: 0, cr: 0, cw: 0 };
    const tc = r.tokenCost || { in: 0, out: 0, cr: 0, cw: 0 };
    const sub = r.subtitle || r.desc || "";
    const text = [title, r.subtitle, r.desc, ws(r).label, ws(r).cwd, ws(r).branch,
      r.id, r.model].filter(Boolean).join(" ").toLowerCase();
    return `<tr data-live="${r.live ? 1 : 0}" data-project="${esc(ws(r).label)}" data-model="${esc(r.model || "")}"
 data-cost="${r.cost}" data-agents="${r.agents}" data-calls="${r.apiCalls ?? 0}"
 ${METRICS.map(([m]) => `data-${m}="${tk[m]}" data-${m}usd="${tc[m]}"`).join(" ")}
 data-text="${esc(text)}">` +
      `<td class=l data-v="${r.live ? 1 : 0}">${r.live ? '<span class="badge live">LIVE</span>'
        : '<span class="badge done">closed</span>'}</td>` +
      `<td class="l ag" data-v="${esc(title.toLowerCase())}" title="${esc(r.desc || "")}">` +
      `<div class=agl><a href="/session/${esc(r.id)}${tokenQS}">${esc(title)}</a></div>` +
      `<div class=agd><span class=mono>${esc(r.id.slice(0, 8))}</span>${sub ? " · " + esc(sub) : ""}</div></td>` +
      `<td class="l proj" data-v="${esc(ws(r).label)}" title="${esc(ws(r).cwd || "")}">` +
      `<div class=m1>${esc(ws(r).label)}</div>` +
      `<div class=m2>${ws(r).branch ? "⎇ " + esc(ws(r).branch) : ""}</div></td>` +
      `<td class="l dim mono" data-v="${esc(r.start || "")}">${esc((r.start || "").slice(0, 16).replace("T", " "))}</td>` +
      `<td class="r dim" data-v="${r.durationS ?? 0}">${fmtDur(r.durationS)}</td>` +
      `<td class="r dim" data-v="${r.agents}">${r.agents}</td>` +
      `<td class="r dim" data-v="${r.apiCalls ?? 0}">${num(r.apiCalls)}</td>` +
      METRICS.map(([m]) => `<td class="r${tk[m] ? "" : " zero"}" data-v="${tk[m]}">` +
        `${tk[m] ? `${kTok(tk[m])}<span class=usd>${usd(tc[m])}</span>` : "·"}</td>`).join("") +
      `<td class="r money" data-v="${r.cost}">${usd(r.cost)}</td></tr>`;
  }).join("\n");

  return `<!doctype html><meta charset=utf-8><title>agent-atlas</title>
<style>${CSS}</style><body class=tree>
<div class=head><h1>agent-atlas</h1>
 <div class=sub>cost &amp; agent-tree explorer · <span id=sesscount>${rows.length}</span> sessions on disk</div></div>
<div class=dash>
 <div class="tile lead"><span class=lbl>Total cost</span><b id=k-cost>${usd(sum.cost)}</b>
  <span class=sub><span id=k-n>${rows.length}</span> sessions</span></div>
 <div class=tile><span class=lbl>Avg / session</span><b id=k-avg>${usd(rows.length ? sum.cost / rows.length : 0)}</b>
  <span class=sub>median <span id=k-med>${usd(median)}</span></span></div>
 <div class=tile><span class=lbl>Agents</span><b id=k-agents>${num(sum.agents)}</b>
  <span class=sub><span id=k-calls>${num(sum.calls)}</span> API calls</span></div>
 ${METRICS.map(([m, label]) => `<div class=tile><span class=lbl>${label}</span>
  <b id=k-${m}>${kTok(sum.t[m])}</b><span class=sub id=k-${m}usd>${usd(sum.d[m])}</span></div>`).join("")}
</div>
<div class=toolbar>
 <input id=q placeholder="search session, project, task…" size=30>
 ${combo("proj", "all projects", projects)}
 ${combo("fmodel", "all models", models.map(m =>
   [m, m.replace("claude-", "").replace("-20251001", "")]), "11em")}
 <label><input id=liveonly type=checkbox> live only</label>
 <label><input id=usemin type=checkbox> min $
  <input id=mincost type=number step=0.05 min=0 value=0.5 disabled></label>
</div>
<div id=twrap><table class="tt" id=tt><thead><tr>${head}</tr></thead><tbody>${tr}</tbody></table></div>
<script>
(function(){
 var START=${START_COL}, qs=new URLSearchParams(location.search);
 var sortCol=qs.get('c')!==null?+qs.get('c'):START, sortDir=qs.get('d')==='asc'?1:-1;
 var FILTERS=[['q','q',''],['proj','p',''],['fmodel','m',''],
              ['liveonly','live',false],['usemin','min',false],['mincost','minv','0.5']];
 var METRICS=['in','out','cr','cw'];
 var tb,rows;
 var kTok=function(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'k':String(n)};
 var usd=function(n){return n>0&&n<0.01?'$'+n.toFixed(4):'$'+n.toFixed(2)};
 var $=function(id){return document.getElementById(id)};
 function index(){tb=document.querySelector('#tt tbody'); rows=[].slice.call(tb.rows);}
 function cmp(a,b){
  var x=a.cells[sortCol],y=b.cells[sortCol];
  if(!x||!y)return 0;
  var u=x.dataset.v||'',v=y.dataset.v||'';
  var th=document.querySelector('#tt th[data-c="'+sortCol+'"]');
  if(th&&th.dataset.n==='1')return ((+u)-(+v))*sortDir;
  return (u<v?-1:u>v?1:0)*sortDir;
 }
 function apply(){
  var q=$('q').value.trim().toLowerCase(), pr=$('proj').value, md=$('fmodel').value;
  var lo=$('liveonly').checked, um=$('usemin').checked;
  var mc=um?(parseFloat($('mincost').value)||0):0;
  $('mincost').disabled=!um;
  rows.sort(cmp);
  var vis=[], cost=0, agents=0, calls=0, tok={}, tc={};
  METRICS.forEach(function(m){tok[m]=0;tc[m]=0});
  rows.forEach(function(r){
   var d=r.dataset;
   var ok=(+d.cost>=mc)&&(!pr||d.project===pr)&&(!md||d.model===md)&&(!lo||d.live==='1')
     &&(!q||d.text.indexOf(q)>-1);
   r.style.display=ok?'':'none';
   tb.appendChild(r);
   if(!ok)return;
   vis.push(+d.cost); cost+=+d.cost; agents+=+d.agents; calls+=+d.calls;
   METRICS.forEach(function(m){tok[m]+=+d[m]; tc[m]+=+d[m+'usd'];});
  });
  var n=vis.length;
  $('k-cost').textContent=usd(cost); $('k-n').textContent=n;
  $('k-avg').textContent=n?usd(cost/n):'—';
  vis.sort(function(a,b){return a-b});
  $('k-med').textContent=n?usd(vis[n>>1]):'—';
  $('k-agents').textContent=agents; $('k-calls').textContent=calls.toLocaleString('en');
  METRICS.forEach(function(m){$('k-'+m).textContent=kTok(tok[m]); $('k-'+m+'usd').textContent=usd(tc[m]);});
  [].forEach.call(document.querySelectorAll('#tt th[data-c]'),function(th){
   var on=+th.dataset.c===sortCol;
   th.className=th.className.replace(/ on\b/,'')+(on?' on':'');
   th.querySelector('.arr').textContent=on?(sortDir<0?'▼':'▲'):'⇅';
  });
 }
 function save(){
  var u=new URL(location.href);
  if(sortCol===START&&sortDir===-1){u.searchParams.delete('c');u.searchParams.delete('d');}
  else{u.searchParams.set('c',sortCol);u.searchParams.set('d',sortDir<0?'desc':'asc');}
  FILTERS.forEach(function(f){
   var e=document.getElementById(f[0]);
   var v=e.type==='checkbox'?e.checked:e.value;
   var dflt=f[2];
   if(String(v)===String(dflt)||v==='')u.searchParams.delete(f[1]);
   else u.searchParams.set(f[1],e.type==='checkbox'?'1':v);
  });
  history.replaceState(null,'',u);
 }
 document.addEventListener('click',function(e){
  var th=e.target.closest&&e.target.closest('#tt th[data-c]'); if(!th)return;
  var c=+th.dataset.c;
  if(c===sortCol)sortDir=-sortDir; else {sortCol=c;sortDir=th.dataset.n==='1'?-1:1;}
  apply(); save();
 });
 ['q','proj','fmodel','liveonly','usemin','mincost'].forEach(function(id){
  var e=$(id);
  var h=function(){apply(); save();};
  e.addEventListener('input',h); e.addEventListener('change',h);});
 FILTERS.forEach(function(f){                  // restore from the URL before first paint
  var e=document.getElementById(f[0]), v=qs.get(f[1]);
  if(v===null)return;
  if(e.type==='checkbox')e.checked=v==='1'; else e.value=v;
 });
 ${COMBO_JS}
 index(); apply();
 // Refresh in place instead of reloading: swap the rows, keep the filters,
 // the sort and the scroll position exactly as they were.
 setInterval(function(){
  fetch(location.href,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){
   if(!h)return;
   var doc=new DOMParser().parseFromString(h,'text/html');
   var nb=doc.querySelector('#tt tbody'); if(!nb)return;
   var y=window.scrollY, c=doc.getElementById('sesscount');
   tb.replaceWith(nb); index();
   if(c)$('sesscount').textContent=c.textContent;
   apply(); window.scrollTo(0,y);
  }).catch(function(){});
 },60000);
})();
</script>`;
}

// ----------------------------------------------------------------- tree page
// Stat tiles over a table of agents. Related fields are stacked rather than
// given a column each: agent over its task, model over its effort, token count
// over what those tokens cost.
//
// Every metric has one column, and its reading depends on the row's state:
// collapsed it reports the whole subtree, expanded it drops to this node's own
// share — because the rest is then visible as rows inside it. Expanding a row
// opens a real table of its children, with its own headers, recursively.
const LIVE_MS = 120_000;

export function treeHTML(tree, opts = {}) {
  const { title = "", live = false, backHref = null, refresh = 0 } = opts;
  const now = Date.now();

  const agg = subtreeTotals(tree);

  const keyOf = n => n.agentId || n.agent + "@" + (n.start || "");
  const METRICS = [["in", "in"], ["out", "out"], ["cr", "cache read"], ["cw", "cache write"]];
  const isLive = n => !!n.end && now - new Date(n.end).getTime() < LIVE_MS;
  const shortDate = s => s ? s.slice(5, 16).replace("T", " ") : "";
  const models = new Set();

  // header: [label, sortable, numeric, extra class]
  const COLS = [
    ["", 0, 0, "twc"], ["agent", 1, 0, "l"], ["model", 1, 0, "l"],
    ["started", 1, 0, "l"], ["dur", 1, 1, "r"], ["calls", 1, 1, "r"],
    ...METRICS.map(([, l]) => [l, 1, 1, "r"]), ["cost", 1, 1, "r"],
  ];
  const NCOLS = COLS.length;
  const START_COL = 3;
  const head = COLS.map(([label, sortable, numeric, cls], i) =>
    `<th class="${cls}${sortable ? " s" : ""}"${sortable ? ` data-c="${i}" data-n="${numeric}"` : ""}>` +
    `${esc(label)}${sortable ? `<span class=arr></span>` : ""}</th>`).join("");

  function row(n, depth, parentKey, open) {
    const a = agg.get(n), leaf = !n.children.length, k = keyOf(n);
    const share = n.__share || 0;
    const model = shortModel(n.model);
    n.model.forEach(m => models.add(m));
    const conf = n.cost.confidence === "computed" ? `<span class=conf-computed>± </span>` :
                 n.cost.confidence === "reported" ? `<span class=conf-reported>rep </span>` : "";
    const chips = (n.phase != null ? `<span class=chip>${esc(n.phase)}${n.round != null ? " r" + esc(n.round) : ""}</span>` : "")
      + ((n.skills && n.skills.length) ? `<span class=chip>⚙ ${esc(n.skills.slice(0, 3).join(" → "))}${n.skills.length > 3 ? " …" : ""}</span>` : "");
    const shown = open && !leaf;          // open rows drop to their own share
    const cells = METRICS.map(([m]) => {
      const v = shown ? a.own.t[m] : a.tot.t[m], c = shown ? a.own.d[m] : a.tot.d[m];
      return `<td class="r ctx${v ? "" : " zero"}" data-v="${a.tot.t[m]}"` +
        ` data-tot="${a.tot.t[m]}" data-own="${a.own.t[m]}"` +
        ` data-totusd="${a.tot.d[m]}" data-ownusd="${a.own.d[m]}">` +
        `<span class=v>${v ? kTok(v) : "·"}</span><span class=usd>${v ? usd(c) : ""}</span></td>`;
    }).join("") + (() => {
      const v = shown ? n.cost.own : n.cost.total;
      return `<td class="r ctx money${v ? "" : " zero"}" data-v="${n.cost.total}"` +
        ` data-tot="${n.cost.total}" data-own="${n.cost.own}">${conf}<span class=v>${v ? usd(v) : "·"}</span></td>`;
    })();
    // one searchable haystack per row: anything on screen should be findable
    const text = [n.agent, n.description, (n.skills || []).join(" "), model,
      n.effort.join(" "), n.phase, n.agentId, n.via].filter(Boolean).join(" ").toLowerCase();
    return `<tr data-key="${esc(k)}" data-parent="${esc(parentKey || "")}" data-depth="${depth}"` +
      ` data-leaf="${leaf ? 1 : 0}" data-open="${shown ? 1 : 0}" data-model="${esc(n.model.join(" "))}"` +
      ` data-text="${esc(text)}" title="${esc((n.firstPrompt || "").slice(0, 300))}">` +
      `<td class=twc><span class=tw></span></td>` +
      `<td class="l ag" data-v="${esc(n.agent)}" style="--w:${share}%">` +
      `<div class=agl>${isLive(n) ? '<span class="badge live">LIVE</span>' : ""}` +
      `${n.via === "cli" ? `<span class="badge cli">CLI${n.provider !== "claude" ? " · " + esc(n.provider) : ""}</span>` : ""}` +
      `<span class=a>${esc(n.agent)}</span>${share ? `<span class=sh>${share}%</span>` : ""}</div>` +
      (n.description || chips ? `<div class=agd>${esc(n.description ?? "")}${chips}</div>` : "") + `</td>` +
      `<td class=l data-v="${esc(model)}"><div class=m1>${esc(model)}</div>` +
      `<div class=m2>${esc(n.effort.join(",") || "—")}</div></td>` +
      `<td class="l dim mono" data-v="${esc(n.start || "")}">${esc(shortDate(n.start))}</td>` +
      `<td class="r dim" data-v="${n.durationS ?? 0}">${fmtDur(n.durationS)}</td>` +
      `<td class="r dim" data-v="${n.apiCalls}">${n.apiCalls}</td>` + cells + `</tr>`;
  }

  // only the root unfolds — there is exactly one, and a session that showed
  // nothing but "main" would be useless. Everything below it starts folded.
  function render(n, depth, parentKey, open) {
    for (const c of n.children)
      c.__share = n.cost.total > 0 ? Math.round(c.cost.total / n.cost.total * 100) : 0;
    let s = row(n, depth, parentKey, open);
    if (n.children.length) {
      const inner = n.children.map(c => render(c, depth + 1, keyOf(n), false)).join("");
      s += `<tr class=sub data-for="${esc(keyOf(n))}"${open ? "" : ' style="display:none"'}>` +
        `<td class=nest colspan=${NCOLS}><div class=nestbox>` +
        `<div class=nestlbl>${n.children.length} subagent${n.children.length > 1 ? "s" : ""} · ${esc(n.agent)}</div>` +
        `<table class="tt sub-tt"><thead><tr>${head}</tr></thead><tbody>${inner}</tbody></table>` +
        `</div></td></tr>`;
    }
    return s;
  }
  const body = render(tree, 0, null, true);

  const t = tree, R = agg.get(tree), ws = opts.workspace || { label: "", cwd: "", branch: t.branch };
  const nAgents = (function cnt(n) { return n.children.reduce((a, c) => a + 1 + cnt(c), 0); })(t);
  const d = opts.describe || null;
  const sesTitle = (d && d.title) || t.summary || t.identity?.customTitle || t.identity?.agentName || t.agent;

  return `<!doctype html><meta charset=utf-8><title>${esc(title || sesTitle)}</title>
<style>${CSS}</style><body class=tree>
${backHref ? `<p style="margin:0 0 .9em"><a href="${esc(backHref)}">← sessions</a></p>` : ""}
<div class=head>
 <div class=idline><span class=mono>${esc((t.agentId || "").slice(0, 8))}</span>${
   t.start ? ` · ${esc(t.start.slice(0, 16).replace("T", " "))}` : ""}${
   t.durationS != null ? ` · ${fmtDur(t.durationS)}` : ""}</div>
 <h1>${esc(sesTitle)}</h1>
 <div class=badges>
  ${live ? '<span class="badge st on-live">● live</span>'
          : '<span class="badge st">✓ closed</span>'}
  ${ws.label ? `<span class=badge title="${esc(ws.cwd)}">📁 ${esc(ws.label)}</span>` : ""}
  ${ws.branch ? (ws.branchUrl
    ? `<a class="badge link" href="${esc(ws.branchUrl)}" target=_blank title="branch on ${esc(ws.repo)} — may be gone if it was merged and deleted">⎇ ${esc(ws.branch)}</a>`
    : `<span class=badge>⎇ ${esc(ws.branch)}</span>`) : ""}
  ${t.repo?.prUrl ? `<a class="badge link" href="${esc(t.repo.prUrl)}" target=_blank>↗ PR #${esc(t.repo.prNumber)}</a>` : ""}
 </div>
 ${t.firstPrompt ? (t.firstPrompt.length > 200
   ? `<details class=prompt><summary><span class=t>${esc(t.firstPrompt)}</span></summary></details>`
   : `<div class=prompt>${esc(t.firstPrompt)}</div>`) : ""}
</div>
<div class=dash>
 <div class="tile lead"><span class=lbl>Total cost</span><b>${usd(t.cost.total)}</b>
  <span class=sub>main ${usd(t.cost.own)} · agents ${usd(t.cost.children)}</span></div>
 <div class=tile><span class=lbl>Agents</span><b>${nAgents}</b>
  <span class=sub>${usd(t.cost.children)}</span></div>
 ${METRICS.map(([m, label]) => `<div class=tile><span class=lbl>${label}</span>
  <b>${kTok(R.tot.t[m])}</b><span class=sub>${usd(R.tot.d[m])}</span></div>`).join("")}
 <div class=tile><span class=lbl>Duration</span><b>${fmtDur(t.durationS)}</b>
  <span class=sub>${num(t.apiCalls)} API calls</span></div>
 <div class=tile><span class=lbl>Model</span><b>${esc(shortModel(t.model.slice(0, 1)))}</b>
  <span class=sub>${esc(t.effort.join(",") || "—")}</span></div>
</div>
<div class=toolbar>
 <input id=q placeholder="search agent, task, skill, model…" size=30>
 ${combo("fmodel", "all models", [...models].sort().map(m =>
   [m, m.replace("claude-", "").replace("-20251001", "")]), "11em")}
 <span class=legend id=leg style="margin-left:auto">collapsed = subtree total · expanded = this agent only</span></div>
<div id=twrap>
<table class="tt" id=tt><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
<script>
(function(){
 var REFRESH=${refresh}, START=${START_COL}, qs=new URLSearchParams(location.search);
 var sortCol=qs.get('c')!==null?+qs.get('c'):START, sortDir=qs.get('d')==='desc'?-1:1;
 var FILTERS=[['q','q'],['fmodel','m']];
 var rows,byKey;
 var kTok=function(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'k':String(n)};
 var usd=function(n){return n>0&&n<0.01?'$'+n.toFixed(4):'$'+n.toFixed(2)};
 function index(){
  rows=[].slice.call(document.querySelectorAll('#twrap tr[data-key]'));
  byKey={}; rows.forEach(function(r){byKey[r.dataset.key]=r;});
 }
 var subOf=function(r){return document.querySelector('#twrap tr.sub[data-for="'+r.dataset.key+'"]')};
 function cmp(a,b){
  var x=a.cells[sortCol],y=b.cells[sortCol];
  if(!x||!y)return 0;
  var u=x.dataset.v||'',v=y.dataset.v||'';
  var th=document.querySelector('#tt th[data-c="'+sortCol+'"]');
  if(th&&th.dataset.n==='1')return ((+u)-(+v))*sortDir;
  return (u<v?-1:u>v?1:0)*sortDir;
 }
 function order(){                              // each subtable sorts its own rows
  [].forEach.call(document.querySelectorAll('#twrap tbody'),function(tb){
   var items=[].slice.call(tb.children).filter(function(r){return r.dataset.key});
   items.sort(cmp);
   items.forEach(function(r){var s=subOf(r); tb.appendChild(r); if(s)tb.appendChild(s);});
  });
  [].forEach.call(document.querySelectorAll('#twrap th[data-c]'),function(th){
   var on=+th.dataset.c===sortCol;
   th.className=th.className.replace(/ on\b/,'')+(on?' on':'');
   th.querySelector('.arr').textContent=on?(sortDir<0?'▼':'▲'):'⇅';
  });
 }
 // a filter keeps a row if it matches, or if anything under it does: an agent
 // is only reachable through its ancestors
 function hits(){
  var q=document.getElementById('q').value.trim().toLowerCase();
  var m=document.getElementById('fmodel').value;
  if(!q&&!m)return null;
  var keep={};
  rows.forEach(function(r){
   if((q&&r.dataset.text.indexOf(q)<0)||(m&&r.dataset.model.indexOf(m)<0))return;
   var k=r.dataset.key;
   while(k){keep[k]=1; var pr=byKey[k]; k=pr?pr.dataset.parent:'';}
  });
  return keep;
 }
 function paint(){
  var keep=hits();
  rows.forEach(function(r){
   r.style.display=(!keep||keep[r.dataset.key])?'':'none';
   var s=subOf(r); if(s)s.style.display=(keep||r.dataset.open==='1')?'':'none';
   var own=r.dataset.open==='1';
   [].forEach.call(r.querySelectorAll('td.ctx'),function(td){
    var v=+(own?td.dataset.own:td.dataset.tot);
    td.querySelector('.v').textContent=v?(td.classList.contains('money')?usd(v):kTok(v)):'·';
    var u=td.querySelector('.usd');
    if(u)u.textContent=v?usd(+(own?td.dataset.ownusd:td.dataset.totusd)):'';
    td.classList.toggle('zero',!v);
   });
  });
 }
 function save(){
  var u=new URL(location.href);
  if(sortCol===START&&sortDir===1){u.searchParams.delete('c');u.searchParams.delete('d');}
  else{u.searchParams.set('c',sortCol);u.searchParams.set('d',sortDir<0?'desc':'asc');}
  FILTERS.forEach(function(f){
   var v=document.getElementById(f[0]).value;
   v?u.searchParams.set(f[1],v):u.searchParams.delete(f[1]);
  });
  history.replaceState(null,'',u);
 }
 document.addEventListener('click',function(e){
  if(!e.target.closest)return;
  var th=e.target.closest('#twrap th[data-c]');
  if(th){var c=+th.dataset.c;
   if(c===sortCol)sortDir=-sortDir; else {sortCol=c;sortDir=th.dataset.n==='1'?-1:1;}
   order(); save(); return;}
  var td=e.target.closest('td.ag')||e.target.closest('td.twc'); if(!td)return;
  var r=td.closest('tr'); if(r.dataset.leaf==='1')return;
  r.dataset.open=r.dataset.open==='1'?'0':'1'; paint();
 });
 ['q','fmodel'].forEach(function(id){var e=document.getElementById(id);
  var h=function(){paint(); save();};
  e.addEventListener('input',h); e.addEventListener('change',h);});
 FILTERS.forEach(function(f){                  // restore from the URL before first paint
  var v=qs.get(f[1]); if(v!==null)document.getElementById(f[0]).value=v;
 });
 ${COMBO_JS}
 index(); order(); paint();
 // Live sessions refresh in place: swap the table, then put back what the user
 // had — open nodes, sort, filters and scroll position.
 function tick(){
  fetch(location.href,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){
   if(!h)return;
   var doc=new DOMParser().parseFromString(h,'text/html');
   var nt=doc.querySelector('#tt'),nd=doc.querySelector('.dash'),nh=doc.querySelector('.head');
   if(!nt)return;
   var open={},y=window.scrollY;
   rows.forEach(function(r){if(r.dataset.open==='1')open[r.dataset.key]=1});
   document.getElementById('tt').replaceWith(nt);
   if(nd)document.querySelector('.dash').replaceWith(nd);
   if(nh)document.querySelector('.head').replaceWith(nh);
   index();
   rows.forEach(function(r){if(r.dataset.leaf!=='1')r.dataset.open=open[r.dataset.key]?'1':'0';});
   order(); paint(); window.scrollTo(0,y);
  }).catch(function(){});
 }
 if(REFRESH)setInterval(tick,REFRESH*1000);
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
    const meta = `${shortModel(n.model)} ${n.effort.join(",")} ${fmtDur(n.durationS)} ${n.apiCalls}c out ${kTok(n.tokens.output)} cR ${kTok(n.tokens.cacheRead)} cW ${kTok(n.tokens.cacheWrite5m + n.tokens.cacheWrite1h)}`;
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
