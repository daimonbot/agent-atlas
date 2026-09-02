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

// Paints a breakdown panel. Callers supply rows as {k, c, v, d[4], root} and
// the labels; on the cost metric the bar carries its own composition, in the
// fixed hue order, and a long tail of small rows folds into "other".
const BD_JS = `
 var TOKL=['IN','OUT','CR','CW'];
 function bdPaint(el,rows,fmt,split,head,bdAll,fold){
  var tot=rows.reduce(function(a,r){return a+r.v;},0)||1, tail=[];
  if(fold&&!bdAll&&rows.length>6){
   tail=rows.filter(function(r){return r.v/tot<0.002;});
   if(tail.length>1){
    rows=rows.filter(function(r){return tail.indexOf(r)<0;});
    var o={k:'other ('+tail.length+')',c:tail.reduce(function(a,r){return a+r.c;},0),
           v:tail.reduce(function(a,r){return a+r.v;},0),d:[0,0,0,0],other:true};
    tail.forEach(function(r){ for(var j=0;j<4;j++)o.d[j]+=r.d[j]; });
    rows.push(o);
   } else tail=[];
  }
  var max=rows.reduce(function(a,r){return Math.max(a,r.v);},1);
  var body=rows.map(function(r){
   var inner;
   if(split&&r.v>0){
    inner=TOKL.map(function(l,i){
     return r.d[i]>0?'<i style="width:'+(r.d[i]/r.v*100).toFixed(2)+
      '%;background:var(--s'+(i+1)+')" title="'+l+'"></i>':''; }).join('');
   } else inner='<i style="width:100%"></i>';
   return '<div class="bd-row'+(r.root?' is-main':'')+(r.other?' is-other':'')+'"'+
    ' data-k="'+r.k.replace(/["&<>]/g,'')+'" data-c="'+r.c+'" data-v="'+r.v+'"'+
    ' data-vf="'+fmt(r.v)+'" data-p="'+(r.v/tot*100).toFixed(1)+'"'+
    ' data-d="'+r.d.join(',')+'">'+
    '<span class=bd-name>'+r.k.replace(/[&<>]/g,'')+(r.c>1?'<i>×'+r.c+'</i>':'')+'</span>'+
    '<span class="bd-bar'+(split?' split':'')+'" style="--w:'+(r.v/max*100).toFixed(2)+'%">'+
    inner+'</span><span class=bd-val>'+fmt(r.v)+'</span>'+
    '<span class=bd-pct>'+(r.v/tot*100).toFixed(1)+'%</span></div>';
  }).join('');
  var legend=split?'<div class=bd-legend>'+TOKL.map(function(l,i){
   return '<span><i style="background:var(--s'+(i+1)+')"></i>'+l+'</span>'; }).join('')+'</div>':'';
  var more=(tail.length||bdAll)?'<button class=bd-more>'+
   (bdAll?'show less':'show '+tail.length+' more')+'</button>':'';
  el.innerHTML=head(fmt(tot))+'<div class=bd-rows>'+body+more+'</div>'+legend+
   '<div class=bd-tip hidden></div>';
 }
 // a hovered row explains its own split: amount and share per token class
 function bdTip(row,tip){
  var d=row.dataset.d.split(',').map(Number);
  var sum=d.reduce(function(a,b){return a+b;},0);
  var L=['IN','OUT','CACHE READ','CACHE WRITE'];
  tip.innerHTML='<div class=tip-h>'+row.dataset.k+
   (+row.dataset.c>1?' <i>×'+row.dataset.c+'</i>':'')+'</div>'+
   L.map(function(l,i){
    return '<div class=tip-r><i style="background:var(--s'+(i+1)+')"></i>'+
     '<span>'+l+'</span><b>'+bdUsd(d[i])+'</b><u>'+
     (sum?(d[i]/sum*100).toFixed(1):'0.0')+'%</u></div>'; }).join('')+
   '<div class="tip-r tip-t"><i></i><span>cost</span><b>'+bdUsd(sum)+'</b><u></u></div>'+
   (row.dataset.vf!==bdUsd(sum)
     ? '<div class="tip-r tip-t"><i></i><span>selected metric</span><b>'+row.dataset.vf+
       '</b><u>'+row.dataset.p+'%</u></div>' : '');
  tip.hidden=false;
 }
 function bdUsd(n){ return n>0&&n<0.01?'$'+n.toFixed(4):'$'+n.toFixed(2); }
 document.addEventListener('mouseover',function(e){
  if(!e.target.closest)return;
  var row=e.target.closest('.bd-row'); if(!row)return;
  var wrap=row.closest('.bd'), tip=wrap&&wrap.querySelector('.bd-tip');
  if(!tip)return;
  bdTip(row,tip);
  var rb=row.getBoundingClientRect(), wb=wrap.getBoundingClientRect();
  tip.style.top=(rb.bottom-wb.top+6)+'px';
  tip.style.left=Math.min(rb.left-wb.left+90,wb.width-250)+'px';
 });
 document.addEventListener('mouseout',function(e){
  if(!e.target.closest)return;
  var row=e.target.closest('.bd-row'); if(!row)return;
  if(e.relatedTarget&&row.contains(e.relatedTarget))return;
  var wrap=row.closest('.bd'), tip=wrap&&wrap.querySelector('.bd-tip');
  if(tip)tip.hidden=true;
 });
 function bdSeg(id,items,cur){
  return '<span class=seg>'+items.map(function(it){
   return '<button data-'+id+'="'+it[0]+'"'+(it[0]===cur?' class=on':'')+'>'+it[1]+'</button>';
  }).join('')+'</span>';
 }`;

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
export function perAgent(root) {
  const by = {};
  (function walk(n, depth) {
    if (depth) {
      const p = n.costParts || { in: 0, out: 0, cr: 0, cw: 0 };
      const g = by[n.agent] || (by[n.agent] = { c: 0, o: 0, d: [0, 0, 0, 0], ms: 0,
        t: [0, 0, 0, 0] });
      g.c++; g.o += n.cost.own;
      g.d[0] += p.in; g.d[1] += p.out; g.d[2] += p.cr; g.d[3] += p.cw;
      g.t[0] += n.tokens.input; g.t[1] += n.tokens.output;
      g.t[2] += n.tokens.cacheRead; g.t[3] += n.tokens.cacheWrite5m + n.tokens.cacheWrite1h;
      if (n.start && n.end) g.ms += Date.parse(n.end) - Date.parse(n.start);
    }
    for (const c of n.children) walk(c, depth + 1);
  })(root, 0);
  for (const k in by) { by[k].o = +by[k].o.toFixed(4);
    by[k].d = by[k].d.map(v => +v.toFixed(6)); }
  return by;
}

export function agentMs(root) {
  let ms = 0;
  (function walk(n, depth) {
    if (depth && n.start && n.end) ms += Date.parse(n.end) - Date.parse(n.start);
    for (const c of n.children) walk(c, depth + 1);
  })(root, 0);
  return ms;
}

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
.rng{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--card)}
.rbtn{background:none;border:none;border-right:1px solid var(--line);color:var(--mut);font:inherit;
 font-size:11.5px;padding:.35em .6em;cursor:pointer}
.rbtn:last-child{border-right:none}
.rbtn:hover{background:#f2f4f7;color:var(--tx)}
.rbtn.on{background:var(--accbg);color:var(--acc);font-weight:650}
.dates{color:var(--dim);font-size:11.5px}
.dates input{font-size:11.5px;padding:.25em .35em;color-scheme:light}
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
/* ---- breakdown ---- */
.bd{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 1em;
 box-shadow:0 1px 2px rgba(11,11,11,.05);overflow:hidden}
.bd-head{display:flex;align-items:center;gap:.6em;padding:.6em .8em;border-bottom:1px solid var(--line2);
 flex-wrap:wrap}
.bd-head>b{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--mut)}
.bd-tot{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
.seg button{background:none;border:none;border-right:1px solid var(--line);color:var(--mut);
 font:inherit;font-size:11px;padding:.3em .55em;cursor:pointer}
.seg button:last-child{border-right:none}
.seg button:hover{background:#f2f4f7;color:var(--tx)}
.seg button.on{background:var(--accbg);color:var(--acc);font-weight:650}
.bd-rows{padding:.5em .8em .7em}
.bd-row{display:flex;align-items:center;gap:.7em;padding:.22em 0;font-size:11.5px}
.bd-row.is-main .bd-name{font-weight:700}
.bd-row.is-main .bd-bar i{background:var(--tx)}
.bd-name{flex:0 0 13em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tx)}
.bd-name i{font-style:normal;color:var(--dim);margin-left:.35em;font-size:10.5px}
.bd-bar{flex:1 1 auto;height:9px;background:#f0f1f4;border-radius:3px;min-width:4em;overflow:hidden}
.bd-bar i{display:block;height:100%;background:var(--acc);border-radius:3px}
/* cost bars carry their own composition: fixed hue order, 2px surface gaps */
.bd-bar.split{display:flex;gap:2px;width:var(--w);flex:0 0 auto;background:none;min-width:2px}
.bd-bar.split i{border-radius:2px;min-width:1px}
.bd-bar.split i:first-child{border-radius:3px 2px 2px 3px}
.bd-bar.split i:last-child{border-radius:2px 3px 3px 2px}
.bd-row:has(.bd-bar.split){gap:0}
.bd-row .bd-bar.split{margin-right:.7em}
.bd-rows:has(.bd-bar.split) .bd-row{display:grid;grid-template-columns:13em 1fr 6.5em 3.6em;align-items:center}
.bd-legend{display:flex;gap:1.1em;flex-wrap:wrap;padding:.1em .8em .8em;font-size:10.5px;color:var(--mut)}
.bd-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:.4em}
.bd-more{background:none;border:none;color:var(--acc);font:inherit;font-size:11px;font-weight:650;
 cursor:pointer;padding:.35em 0 0}
.bd-row.is-other .bd-name{color:var(--mut);font-style:italic}
.bd{position:relative}
.bd-row:hover{background:#f7f8fa;border-radius:5px}
.bd-tip{position:absolute;z-index:30;background:var(--card);border:1px solid var(--line);
 border-radius:9px;box-shadow:0 8px 24px rgba(11,11,11,.15);padding:.5em .6em;min-width:15em;
 pointer-events:none;font-size:11px}
.tip-h{font-weight:700;margin-bottom:.35em;padding-bottom:.35em;border-bottom:1px solid var(--line2)}
.tip-h i{font-style:normal;color:var(--dim);font-weight:400}
.tip-r{display:flex;align-items:center;gap:.5em;padding:.1em 0}
.tip-r i{width:8px;height:8px;border-radius:2px;flex:0 0 8px}
.tip-r span{color:var(--mut);flex:1 1 auto}
.tip-r b{font-weight:650;font-variant-numeric:tabular-nums}
.tip-r u{text-decoration:none;color:var(--dim);width:3.4em;text-align:right;
 font-variant-numeric:tabular-nums}
.tip-t{margin-top:.3em;padding-top:.35em;border-top:1px solid var(--line2)}
.tip-t span{color:var(--tx);font-weight:600}
.bd-val{flex:0 0 6.5em;text-align:right;font-weight:650;font-variant-numeric:tabular-nums}
.bd-pct{flex:0 0 3.6em;text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}
/* ---- view tabs ---- */
.tabs{display:flex;gap:.15em;margin:0 0 .8em;border-bottom:1px solid var(--line)}
.tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--mut);
 font:inherit;font-size:12.5px;font-weight:600;padding:.5em .9em;cursor:pointer;margin-bottom:-1px}
.tab:hover{color:var(--tx)}
.tab.on{color:var(--acc);border-bottom-color:var(--acc)}
.view{display:none} .view.on{display:block}
/* depth ramp: one hue, light to dark, so nesting reads as magnitude */
:root{--dep0:#2a78d6;--dep1:#5f95e0;--dep2:#9dc0ef;--dep3:#cfe0f7}
/* ---- trace ---- */
#trace{padding:.3em 0}
.tl-axis{display:flex;color:var(--dim);font-size:10px;border-bottom:1px solid var(--line);
 padding-bottom:.4em;margin-bottom:.3em;position:sticky;top:0;background:var(--card);z-index:2}
.tl-axis .tl-track{position:relative;height:1.1em}
.tl-axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}
.tl-axis span:first-child{transform:none}
.tl-row{display:flex;align-items:center;height:26px;border-radius:5px}
.tl-row:hover{background:#f6f6f4}
.tl-row.has{cursor:pointer}
.tl-name{flex:0 0 21em;display:flex;align-items:center;gap:.15em;overflow:hidden;
 white-space:nowrap;font-size:12px;padding-right:.7em}
.tl-name .a{overflow:hidden;text-overflow:ellipsis;font-weight:600}
.tl-name .sh{background:#eceef1;border-radius:20px;padding:0 .4em;font-size:10px;color:var(--mut);margin-left:.35em}
.tl-row .tw{flex:0 0 16px;font-size:8px;color:var(--dim);display:inline-flex;justify-content:center}
.tl-row.has .tw::before{content:▶} .tl-row.has.op .tw::before{content:▼}
.tl-track{position:relative;flex:1 1 auto;height:100%;min-width:0}
.tl-track::before{content:;position:absolute;inset:auto 0 0 0;top:50%;border-top:1px dashed #eceef1}
.tl-bar{position:absolute;top:50%;transform:translateY(-50%);height:11px;border-radius:3px;min-width:2px}
#trace{position:relative;user-select:none}
#tl-sel{display:none;position:absolute;top:0;bottom:0;background:rgba(42,120,214,.12);
 border-left:1px solid var(--acc);border-right:1px solid var(--acc);pointer-events:none;z-index:1}
.tl-axis .tl-name{display:flex;align-items:center;font-size:10px}
#tl-reset{background:var(--accbg);border:1px solid #b9d4f4;color:var(--acc);border-radius:6px;
 padding:.1em .5em;font:inherit;font-size:10px;font-weight:600;cursor:pointer}
.tl-lbl{position:absolute;top:50%;transform:translateY(-50%);font-size:10.5px;color:var(--mut);
 white-space:nowrap;pointer-events:none}
/* ---- flow ---- */
#flow{padding:.6em .7em}
.fw-stage{border:1px solid var(--line);border-radius:10px;background:#fbfbfa}
.fw-head{display:flex;align-items:center;gap:.6em;padding:.5em .7em;border-bottom:1px solid var(--line);
 font-size:11px;color:var(--mut);flex-wrap:wrap}
.fw-when{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.fw-head .fw-bd{margin:0 0 0 auto}
.fw-head .fw-bd span{min-width:4em}
/* one quiet line of figures, not a stacked block */
.fw-line{margin-left:auto;display:flex;gap:.85em;align-items:baseline;font-size:10.5px;color:var(--dim)}
.fw-line>span{white-space:nowrap}
.fw-line b{font-weight:650;color:var(--mut);font-variant-numeric:tabular-nums}
.fw-line u{text-decoration:none;color:var(--dim);font-variant-numeric:tabular-nums}
.fw-line>span.zero b{color:#c9c8c4;font-weight:400}
.fw-head b{background:none;color:var(--dim);border:1px solid var(--line);border-radius:6px;
 min-width:1.6em;text-align:center;padding:.05em .3em;font-size:11px;font-weight:650}
.fw-head .fw-t{font-weight:650;color:var(--tx)}
.fw-n em{font-style:normal;color:var(--dim)}
.fw-head .fw-c{font-weight:700;font-size:14px;color:var(--tx);
 font-variant-numeric:tabular-nums;padding-left:.5em}
.fw-boxes{display:flex;flex-wrap:wrap;gap:.5em;padding:.6em .7em}
.fw-box{flex:0 0 auto;width:19.5em;background:var(--card);border:1px solid var(--line);
 border-radius:8px;padding:.5em .65em;cursor:pointer;box-shadow:0 1px 2px rgba(11,11,11,.04)}
.fw-box:hover{border-color:var(--acc)}
.fw-box.has{cursor:pointer}
.fw-box.open{border-color:var(--acc);border-bottom-left-radius:0;border-bottom-right-radius:0;
 box-shadow:none;position:relative;z-index:2;margin-bottom:-9px;padding-bottom:.9em}
.fw-subs{margin:.5em -.65em -.5em;padding:.45em .65em .5em;background:#f7f8fa;
 border-top:1px solid var(--line2);border-radius:0 0 7px 7px}
.fw-open{display:flex;gap:.4em;align-items:baseline;font-size:10.5px;color:var(--acc);font-weight:650}
.fw-open b{margin-left:auto;font-weight:700;color:var(--tx);font-size:12px}
.fw-subs .fw-bd{margin-top:.3em}
.fw-subs .fw-bd b{color:var(--mut)}
.fw-box.open .fw-subs{border-radius:0}
/* an opened parent hands its own flow the same layout, one level in */
.fw-nest{flex:1 0 100%;border:1px solid var(--acc);border-radius:0 9px 9px 9px;
 background:#f6f9fe;padding:.35em .7em .7em;margin:0 0 .35em;position:relative;z-index:1}
.fw-nesthead{display:flex;gap:.5em;align-items:baseline;padding:.5em .1em .55em;
 font-size:10.5px;color:var(--mut)}
.fw-nesthead>b{color:var(--tx);font-weight:650}
.fw-nesthead span{color:var(--dim)}
.fw-nesthead .fw-nestc{margin-left:auto;font-weight:700;color:var(--tx);font-size:12px}
.fw-nest .fw-stage{background:var(--card)}
.fw-nest .fw-gap{height:1.6em}
.fw-name{display:flex;align-items:baseline;gap:.3em;font-size:12.5px;white-space:nowrap;overflow:hidden}
.fw-name .a{font-weight:650;overflow:hidden;text-overflow:ellipsis}
.fw-cost{margin-left:auto;font-weight:700;font-size:13px;font-variant-numeric:tabular-nums}
.fw-task{font-size:11px;color:var(--mut);margin:.2em 0 .35em;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap}
.fw-meta{display:flex;gap:.5em;align-items:center;font-size:10.5px;color:var(--dim);flex-wrap:wrap}
.fw-model{color:var(--mut);font-weight:600}
.fw-par{background:#eceef1;border-radius:5px;padding:0 .35em;color:var(--mut)}
.fw-model em{font-style:normal;background:#eceef1;border-radius:4px;padding:0 .3em;margin-left:.3em;
 font-weight:500}
.fw-clock{font-size:10.5px;color:var(--dim);margin-top:.15em;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.fw-subline{display:flex;gap:.3em;align-items:baseline;flex-wrap:wrap;font-size:10.5px;
 color:var(--dim);margin-top:.45em;padding-top:.45em;border-top:1px solid var(--line2)}
.fw-subline span{background:#eceef1;color:var(--mut);border-radius:5px;padding:0 .35em}
.fw-subline b{margin-left:auto;font-weight:650;color:var(--mut)}
.fw-par{background:#eceef1;border-radius:5px;padding:0 .35em;color:var(--mut)}
/* token breakdown, same four classes as everywhere else */
.fw-bd{display:flex;gap:.5em;margin-top:.45em}
.fw-bd span{display:flex;flex-direction:column;line-height:1.3;min-width:3.4em}
.fw-bd i{font-style:normal;font-size:9.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.03em}
.fw-bd b{font-size:11px;font-weight:650;font-variant-numeric:tabular-nums}
.fw-bd u{text-decoration:none;font-size:10px;color:var(--mut);font-variant-numeric:tabular-nums}
.fw-bd span.zero b{color:#c9c8c4;font-weight:400}
.fw-bd.box{padding-top:.45em;border-top:1px solid var(--line2)}
.fw-main{background:var(--card);border-color:#b9d4f4;box-shadow:0 1px 2px rgba(11,11,11,.05)}
.fw-main .fw-head{border-bottom-color:var(--line2);background:var(--accbg)}
.fw-title{font-size:13px;font-weight:700;color:var(--tx)}
.fw-mainsub{padding:.5em .7em;font-size:11px;color:var(--mut);line-height:1.5}
/* the divider says plainly that everything under it is a subagent */
.fw-divider{display:flex;align-items:center;gap:.7em;margin:1.1em .1em .8em}
.fw-divider::before,.fw-divider::after{content:"";flex:1;border-top:1px solid var(--line)}
.fw-divider span{color:var(--mut);font-size:10.5px;font-weight:650;text-transform:uppercase;
 letter-spacing:.07em}
.fw-total{display:flex;align-items:baseline;gap:1em;margin-top:.6em;padding:.6em .8em;
 border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:11.5px;color:var(--mut)}
.fw-sum{margin-left:auto;font-variant-numeric:tabular-nums}
.fw-sum i{font-style:normal;color:var(--dim);font-size:10.5px;margin-right:.15em}
.fw-sum b{font-size:15px;font-weight:700;color:var(--tx)}
.fw-gap{display:flex;align-items:center;justify-content:center;height:2.1em;position:relative}
.fw-gap::before{content:"";position:absolute;top:0;bottom:0;left:1.6em;border-left:2px dotted #d3d7dd}
.fw-gap span{background:var(--bg);color:var(--dim);font-size:10.5px;padding:0 .5em;margin-left:.5em;
 position:relative;left:-.2em}
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
    ["started", 1, 0, "l"], ["dur", 1, 1, "r"], ["agent time", 1, 1, "r"],
    ["agents", 1, 1, "r"], ["calls", 1, 1, "r"],
    ...METRICS.map(([, l]) => [l, 1, 1, "r"]), ["cost", 1, 1, "r"],
  ];
  const START_COL = 3;
  const head = COLS.map(([label, sortable, numeric, cls], i) =>
    `<th class="${cls}${sortable ? " s" : ""}"${sortable ? ` data-c="${i}" data-n="${numeric}"` : ""}>` +
    `${esc(label)}${sortable ? `<span class=arr></span>` : ""}</th>`).join("");

  const sum = { cost: 0, agents: 0, calls: 0, ams: 0, t: { in: 0, out: 0, cr: 0, cw: 0 },
                d: { in: 0, out: 0, cr: 0, cw: 0 } };
  for (const r of rows) {
    sum.cost += r.cost; sum.agents += r.agents; sum.calls += r.apiCalls || 0; sum.ams += r.agentMs || 0;
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
 data-start="${r.start ? Date.parse(r.start) : 0}" data-dur="${r.durationS ?? 0}" data-ams="${r.agentMs ?? 0}" data-id="${esc(r.id)}"
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
      `<td class="r dim" data-v="${r.agentMs ?? 0}">${r.agentMs ? fmtDur(Math.round(r.agentMs / 1000)) : "<span class=zero>·</span>"}</td>` +
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
 <div class=tile title="wall clock summed per subagent across the visible sessions">
  <span class=lbl>Agents</span><b id=k-agents>${num(sum.agents)}</b>
  <span class=sub><span id=k-calls>${num(sum.calls)}</span> API calls · <span id=k-ams>${
   fmtDur(Math.round(sum.ams / 1000))}</span> agent time</span></div>
 ${METRICS.map(([m, label]) => `<div class=tile><span class=lbl>${label}</span>
  <b id=k-${m}>${kTok(sum.t[m])}</b><span class=sub id=k-${m}usd>${usd(sum.d[m])}</span></div>`).join("")}
</div>
<div class=toolbar>
 <input id=q placeholder="search session, project, task…" size=30>
 ${combo("proj", "all projects", projects)}
 ${combo("fmodel", "all models", models.map(m =>
   [m, m.replace("claude-", "").replace("-20251001", "")]), "11em")}
 <label><input id=liveonly type=checkbox> live only</label>
 <label><input id=usemin type=checkbox checked> min $
  <input id=mincost type=number step=0.05 min=0 value=0.5></label>
 <span class=rng>${[["1", "24h"], ["7", "7d"], ["30", "30d"], ["90", "90d"],
   ["365", "1y"], ["0", "all"]].map(([v, l]) =>
   `<button class=rbtn data-r="${v}">${l}</button>`).join("")}</span>
 <label class=dates>from <input id=from type=date> to <input id=to type=date></label>
</div>
<div class=bd id=bd></div>
<script type="application/json" id=agentdata>${JSON.stringify(
  Object.fromEntries(rows.filter(r => r.byAgent && Object.keys(r.byAgent).length)
    .map(r => [r.id, r.byAgent]))).replace(/</g, "\\u003c")}</script>
<div id=twrap><table class="tt" id=tt><thead><tr>${head}</tr></thead><tbody>${tr}</tbody></table></div>
<script>
(function(){
 var START=${START_COL}, qs=new URLSearchParams(location.search);
 var sortCol=qs.get('c')!==null?+qs.get('c'):START, sortDir=qs.get('d')==='asc'?1:-1;
 var FILTERS=[['q','q',''],['proj','p',''],['fmodel','m',''],
              ['liveonly','live',false],['usemin','min',true],['mincost','minv','0.5'],
              ['from','from',''],['to','to','']];
 var range=qs.get('r')!==null?+qs.get('r'):30;   // days; 0 = no limit
 var METRICS=['in','out','cr','cw'];
 var BMET=[['cost','cost'],['out','out'],['cr','cache read'],['cw','cache write'],
           ['in','in'],['n','sessions'],['agents','agents'],['calls','calls'],
           ['dur','wall time'],['ams','agent time']];
 var bdGroup=({model:1,agent:1})[qs.get('by')]?qs.get('by'):'project';
 var bdMetric=qs.get('by2')||'cost', bdAll=false;
 var AGENTS=JSON.parse(document.getElementById('agentdata').textContent);
 function bVal(d,k){
  if(k==='cost')return +d.cost;
  if(k==='n')return 1;
  if(k==='agents')return +d.agents;
  if(k==='calls')return +d.calls;
  if(k==='dur')return (+d.dur)*1000;
  if(k==='ams')return +d.ams;
  return +d[k];
 }
 function bFmt(v,k){
  if(k==='cost')return usd(v);
  if(k==='n'||k==='agents'||k==='calls')return Math.round(v).toLocaleString('en');
  if(k==='dur'||k==='ams')return v>=3600000?(v/3600000).toFixed(1)+'h':Math.round(v/60000)+'m';
  return kTok(v);
 }
 function drawBreakdown(vis){
  var by={}, order=[];
  if(bdGroup==='agent'){
   var RES={cost:1,in:1,out:1,cr:1,cw:1};        // metrics where a remainder makes sense
   vis.forEach(function(d){
    var per=AGENTS[d.id]||{};
    if(RES[bdMetric]){
     var whole=bVal(d,bdMetric), sub=0, sd=[0,0,0,0];
     for(var nm in per){ var a2=per[nm];
      sub+=bdMetric==='cost'?a2.o:a2.t[METRICS.indexOf(bdMetric)];
      for(var q=0;q<4;q++)sd[q]+=a2.d[q];
     }
     var rest=whole-sub;
     if(rest>0){
      if(!by['main']){ by['main']={k:'main',c:0,v:0,d:[0,0,0,0],root:true}; order.push('main'); }
      var gm=by['main']; gm.c++; gm.v+=rest;
      METRICS.forEach(function(m,i){ gm.d[i]+=Math.max(+d[m+'usd']-sd[i],0); });
     }
    }
    for(var name in per){
     var a=per[name];
     if(!by[name]){ by[name]={k:name,c:0,v:0,d:[0,0,0,0]}; order.push(name); }
     var g=by[name]; g.c+=a.c;
     g.v+=bdMetric==='cost'?a.o:bdMetric==='n'||bdMetric==='agents'?a.c
        :bdMetric==='calls'?0:bdMetric==='ams'?a.ms:bdMetric==='dur'?a.ms
        :a.t[METRICS.indexOf(bdMetric)];
     for(var j=0;j<4;j++)g.d[j]+=a.d[j];
    }
   });
  } else vis.forEach(function(d){
   var key=(bdGroup==='model'
    ?(d.model?d.model.replace('claude-','').replace('-20251001',''):'—')
    :(d.project||'—'))||'—';
   if(!by[key]){ by[key]={k:key,c:0,v:0,d:[0,0,0,0]}; order.push(key); }
   var g=by[key]; g.c++; g.v+=bVal(d,bdMetric);
   METRICS.forEach(function(m,i){ g.d[i]+=+d[m+'usd']; });
  });
  var rows=order.map(function(k){return by[k];}).sort(function(a,b){return b.v-a.v;});
  bdPaint(document.getElementById('bd'),rows,function(v){return bFmt(v,bdMetric);},
   bdMetric==='cost',
   function(tot){ return '<div class=bd-head><b>Breakdown</b>'+
    bdSeg('g',[['project','by project'],['model','by model'],['agent','by agent']],bdGroup)+
    bdSeg('m',BMET,bdMetric)+'<span class=bd-tot>'+tot+'</span></div>'; },
   bdAll,true);
 }
 document.addEventListener('click',function(e){
  if(!e.target.closest)return;
  var b=e.target.closest('#bd button'); if(!b)return;
  if(b.classList.contains('bd-more'))bdAll=!bdAll;
  else if(b.dataset.g)bdGroup=b.dataset.g; else if(b.dataset.m)bdMetric=b.dataset.m;
  apply();
  var u=new URL(location.href);
  bdGroup==='project'?u.searchParams.delete('by'):u.searchParams.set('by',bdGroup);
  bdMetric==='cost'?u.searchParams.delete('by2'):u.searchParams.set('by2',bdMetric);
  history.replaceState(null,'',u);
 });
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
  var f=$('from').value, tt=$('to').value;
  var lo_t=f?Date.parse(f):(range?Date.now()-range*864e5:0);
  var hi_t=tt?Date.parse(tt)+864e5:Infinity;
  [].forEach.call(document.querySelectorAll('.rbtn'),function(b){
   b.classList.toggle('on',!f&&!tt&&+b.dataset.r===range); });
  rows.sort(cmp);
  var vis=[], shown=[], cost=0, agents=0, calls=0, ams=0, tok={}, tc={};
  METRICS.forEach(function(m){tok[m]=0;tc[m]=0});
  rows.forEach(function(r){
   var d=r.dataset;
   var ok=(+d.cost>=mc)&&(!pr||d.project===pr)&&(!md||d.model===md)&&(!lo||d.live==='1')
     &&(+d.start>=lo_t)&&(+d.start<=hi_t)&&(!q||d.text.indexOf(q)>-1);
   r.style.display=ok?'':'none';
   tb.appendChild(r);
   if(!ok)return;
   shown.push(d);
   vis.push(+d.cost); cost+=+d.cost; agents+=+d.agents; calls+=+d.calls; ams+=+d.ams;
   METRICS.forEach(function(m){tok[m]+=+d[m]; tc[m]+=+d[m+'usd'];});
  });
  drawBreakdown(shown);
  var n=vis.length;
  $('k-cost').textContent=usd(cost); $('k-n').textContent=n;
  $('k-avg').textContent=n?usd(cost/n):'—';
  vis.sort(function(a,b){return a-b});
  $('k-med').textContent=n?usd(vis[n>>1]):'—';
  $('k-agents').textContent=agents; $('k-calls').textContent=calls.toLocaleString('en');
  $('k-ams').textContent=ams>=3600000?(ams/3600000).toFixed(1)+'h':Math.round(ams/60000)+'m';
  METRICS.forEach(function(m){$('k-'+m).textContent=kTok(tok[m]); $('k-'+m+'usd').textContent=usd(tc[m]);});
  [].forEach.call(document.querySelectorAll('#tt th[data-c]'),function(th){
   var on=+th.dataset.c===sortCol;
   th.classList.toggle('on',on);
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
   else u.searchParams.set(f[1],e.type==='checkbox'?(v?'1':'0'):v);
  });
  range===30?u.searchParams.delete('r'):u.searchParams.set('r',range);
  history.replaceState(null,'',u);
 }
 document.addEventListener('click',function(e){
  var th=e.target.closest&&e.target.closest('#tt th[data-c]'); if(!th)return;
  var c=+th.dataset.c;
  if(c===sortCol)sortDir=-sortDir; else {sortCol=c;sortDir=th.dataset.n==='1'?-1:1;}
  apply(); save();
 });
 [].forEach.call(document.querySelectorAll('.rbtn'),function(b){
  b.onclick=function(){ range=+b.dataset.r; $('from').value=''; $('to').value='';
   apply(); save(); };
 });
 ['q','proj','fmodel','liveonly','usemin','mincost','from','to'].forEach(function(id){
  var e=$(id);
  var h=function(){apply(); save();};
  e.addEventListener('input',h); e.addEventListener('change',h);});
 FILTERS.forEach(function(f){                  // restore from the URL before first paint
  var e=document.getElementById(f[0]), v=qs.get(f[1]);
  if(v===null)return;
  if(e.type==='checkbox')e.checked=v==='1'; else e.value=v;
 });
 ${BD_JS}
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
  const agentNames = new Set();

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
    if (depth) agentNames.add(n.agent);
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

  const flat = [];
  (function walk(n, depth, parent) {
    const a = agg.get(n);
    flat.push({ k: keyOf(n), p: parent, d: depth, a: n.agent,
      t: n.description || "", s: n.start ? Date.parse(n.start) : null,
      e: n.end ? Date.parse(n.end) : null, c: n.cost.total, o: n.cost.own,
      n: n.apiCalls, m: shortModel(n.model), ef: n.effort.join(",") || "",
      tk: [a.own.t.in, a.own.t.out, a.own.t.cr, a.own.t.cw],
      dl: [a.own.d.in, a.own.d.out, a.own.d.cr, a.own.d.cw],
      TK: [a.tot.t.in, a.tot.t.out, a.tot.t.cr, a.tot.t.cw],
      DL: [a.tot.d.in, a.tot.d.out, a.tot.d.cr, a.tot.d.cw],
      cli: n.via === "cli" ? 1 : 0 });
    for (const c of n.children) walk(c, depth + 1, keyOf(n));
  })(tree, 0, null);

  const t = tree, R = agg.get(tree), aMs = agentMs(tree), ws = opts.workspace || { label: "", cwd: "", branch: t.branch };
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
 <div class=tile title="wall clock summed per subagent; they overlap, so this can exceed the session">
  <span class=lbl>Agent time</span><b>${fmtDur(Math.round(aMs / 1000))}</b>
  <span class=sub>${t.durationS ? "×" + (aMs / 1000 / t.durationS).toFixed(1) + " of the session" : "—"}</span></div>
 <div class=tile><span class=lbl>Model</span><b>${esc(shortModel(t.model.slice(0, 1)))}</b>
  <span class=sub>${esc(t.effort.join(",") || "—")}</span></div>
</div>
<div class=bd id=bd></div>
<div class=tabs>
 <button class=tab data-v=flow>Flow</button
 ><button class=tab data-v=trace>Trace</button
 ><button class=tab data-v=costs>Costs</button>
</div>
<div class=toolbar id=tb>
 <input id=q placeholder="search agent, task, skill, model…" size=30>
 ${combo("fagent", "all agents", [...agentNames].sort(), "12em")}
 ${combo("fmodel", "all models", [...models].sort().map(m =>
   [m, m.replace("claude-", "").replace("-20251001", "")]), "11em")}
 <span class=legend id=leg style="margin-left:auto"></span></div>
<div id=v-costs class=view><div id=twrap>
<table class="tt" id=tt><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>
<div id=v-trace class="view card"><div id=trace></div></div>
<div id=v-flow class="view card"><div id=flow></div></div>
<script type="application/json" id=nodes>${JSON.stringify(flat).replace(/</g, "\\u003c")}</script>
<script>
(function(){
 var REFRESH=${refresh}, START=${START_COL}, qs=new URLSearchParams(location.search);
 var sortCol=qs.get('c')!==null?+qs.get('c'):START, sortDir=qs.get('d')==='desc'?-1:1;
 var FILTERS=[['q','q'],['fmodel','m'],['fagent','a']];
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
   th.classList.toggle('on',on);
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
 ['q','fmodel','fagent'].forEach(function(id){var e=document.getElementById(id);
  var h=function(){ paint(); save();
   if(view==='trace')drawTrace(); else if(view==='flow')drawFlow(); };
  e.addEventListener('input',h); e.addEventListener('change',h);});
 FILTERS.forEach(function(f){                  // restore from the URL before first paint
  var v=qs.get(f[1]); if(v!==null)document.getElementById(f[0]).value=v;
 });
 ${BD_JS}
 ${COMBO_JS}
 // ---- alternative views: a trace timeline and a flow graph ----
 var NODES=JSON.parse(document.getElementById('nodes').textContent);
 var BYK={}, KIDS={};
 NODES.forEach(function(n){ BYK[n.k]=n; (KIDS[n.p||'']=KIDS[n.p||'']||[]).push(n); });
 var ROOT=NODES[0], T0=ROOT.s, SPAN=Math.max((ROOT.e||0)-(ROOT.s||0),1);
 // visible window; a session is mostly dead time, so the axis is zoomable
 var TA=T0, TB=T0+SPAN;
 var vopen={}; vopen[ROOT.k]=1;                 // same default as the table: only the root
 var v0=qs.get('view'); var view=(v0==='trace'||v0==='costs')?v0:'flow';
 function kidsOf(n){ return KIDS[n.k]||[]; }
 function shown(n){ var p=n.p; while(p){ if(!vopen[p])return false; p=BYK[p]?BYK[p].p:null; } return true; }
 function filtering(){
  return !!(document.getElementById('q').value.trim()||
            document.getElementById('fmodel').value||document.getElementById('fagent').value);
 }
 function passes(n){
  var q=document.getElementById('q').value.trim().toLowerCase();
  var m=document.getElementById('fmodel').value, a=document.getElementById('fagent').value;
  if(a&&n.a!==a)return false;
  if(m&&n.m.indexOf(m.replace('claude-','').replace('-20251001',''))<0)return false;
  if(q&&(n.a+' '+n.t+' '+n.m+' '+n.ef).toLowerCase().indexOf(q)<0)return false;
  return true;
 }
 function dur(ms){ var s=Math.round(ms/1000);
  return s>=3600?(s/3600).toFixed(1)+'h':s>=60?Math.round(s/60)+'m':s+'s'; }
 function tip(n){ return n.a+(n.t?' — '+n.t:'')+'\\n'+n.m+' · '+dur((n.e-n.s))+' · '+n.n+
  ' calls · out '+kTok(n.tk[1])+' · '+usd(n.c)+(kidsOf(n).length?' (own '+usd(n.o)+')':''); }
 var D=function(ms){ return new Date(ms); };
 var hhmm=function(ms){ var d=D(ms);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
 var day=function(ms){ var d=D(ms);
  return d.toLocaleDateString(undefined,{day:'numeric',month:'short'}); };
 function when(a,b){
  var sameDay=D(a).toDateString()===D(b).toDateString();
  return (sameDay?day(a)+' '+hhmm(a):day(a)+' '+hhmm(a))+' → '+(sameDay?hhmm(b):day(b)+' '+hhmm(b));
 }
 var TOKL=['IN','OUT','CR','CW'], TOKS=['IN','OUT','CR','CW'];
 // compact one-liner for stage headers, where the stacked grid was too loud
 function inline(tk,dl){
  return '<span class=fw-line>'+TOKS.map(function(l,i){
   return '<span'+(tk[i]?'':' class=zero')+'>'+esc(l)+' <b>'+(tk[i]?kTok(tk[i]):'·')+'</b>'+
    (tk[i]?' <u>'+usd(dl[i])+'</u>':'')+'</span>'; }).join('')+'</span>';
 }
 function breakdown(tk,dl,cls){
  return '<div class="'+cls+'">'+TOKL.map(function(l,i){
   return '<span'+(tk[i]?'':' class=zero')+'><i>'+esc(l)+'</i><b>'+(tk[i]?kTok(tk[i]):'·')+
    '</b><u>'+(tk[i]?usd(dl[i]):'')+'</u></span>'; }).join('')+'</div>';
 }
 function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

 function drawTrace(){
  var out=[], ticks=[], win=Math.max(TB-TA,1), zoomed=(TB-TA)<SPAN-1;
  for(var i=0;i<=5;i++) ticks.push('<span style="left:'+(i*20)+'%">'+dur(TA-T0+win*i/5)+'</span>');
  out.push('<div class=tl-axis><div class=tl-name>'+
   (zoomed?'<button id=tl-reset>reset zoom</button>':'<span class=dim>drag to zoom</span>')+
   '</div><div class=tl-track>'+ticks.join('')+'</div></div>');
  NODES.forEach(function(n){
   if(!shown(n)||(n.p&&!passes(n)))return;
   if(n.e<TA||n.s>TB)return;                   // outside the window entirely
   var kids=kidsOf(n).length;
   var l=(Math.max(n.s,TA)-TA)/win*100, w=Math.max((Math.min(n.e,TB)-Math.max(n.s,TA))/win*100,0.3);
   var lbl=dur(n.e-n.s)+' · '+usd(n.c);
   out.push('<div class="tl-row'+(kids?' has':'')+'" data-k="'+esc(n.k)+'" title="'+esc(tip(n))+'">'+
    '<div class=tl-name style="padding-left:'+(0.4+n.d*0.9)+'em">'+
     '<span class="tw'+(kids?'':' leaf')+'"></span>'+
     (n.cli?'<span class="badge cli">CLI</span>':'')+
     '<span class=a>'+esc(n.a)+'</span>'+(kids?'<span class=sh>'+kids+'</span>':'')+'</div>'+
    '<div class=tl-track><div class=tl-bar style="left:'+l.toFixed(3)+'%;width:'+w.toFixed(3)+
      '%;background:var(--dep'+Math.min(n.d,3)+')"></div>'+
     '<span class=tl-lbl style="left:'+Math.min(l+w+0.4,88).toFixed(3)+'%">'+esc(lbl)+'</span></div></div>');
  });
  out.push('<div id=tl-sel></div>');
  document.getElementById('trace').innerHTML=out.join('');
  var rst=document.getElementById('tl-reset');
  if(rst)rst.onclick=function(e){ e.stopPropagation(); TA=T0; TB=T0+SPAN; drawTrace(); };
  wireZoom();
 }

 // drag across the tracks to zoom into a window, the way a trace viewer does
 function wireZoom(){
  var host=document.getElementById('trace'), sel=document.getElementById('tl-sel');
  var track=host.querySelector('.tl-axis .tl-track'); if(!track)return;
  var down=null;
  var at=function(ev){ var r=track.getBoundingClientRect();
   return Math.min(Math.max((ev.clientX-r.left)/r.width,0),1); };
  host.addEventListener('mousedown',function(e){
   if(e.target.closest('.tl-name'))return;     // names stay clickable for folding
   down=at(e); sel.style.display='block'; e.preventDefault();
  });
  window.addEventListener('mousemove',function(e){
   if(down===null)return;
   var a=Math.min(down,at(e)), b=Math.max(down,at(e)), r=track.getBoundingClientRect();
   var h=host.getBoundingClientRect();
   sel.style.left=(r.left-h.left+a*r.width)+'px';
   sel.style.width=((b-a)*r.width)+'px';
  });
  window.addEventListener('mouseup',function(e){
   if(down===null)return;
   var a=Math.min(down,at(e)), b=Math.max(down,at(e));
   down=null; sel.style.display='none';
   if(b-a<0.005)return;                        // a click, not a drag
   var win=TB-TA;
   TB=TA+win*b; TA=TA+win*a;
   drawTrace();
  });
 }

 // Flow reads as time, not as dependency: at each level the agents are grouped
 // into waves — a wave is a run of agents whose intervals overlap, so it is
 // literally "these ran at the same time" — and waves follow each other in
 // order with the idle gap between them made explicit. An agent that spawned
 // its own subagents opens into the very same layout one level down, which is
 // what makes the parent/child relation structural rather than a label.
 var fopen={};
 function wavesOf(parentKey){
  var pool=(parentKey===ROOT.k&&filtering())
   ? NODES.slice(1) : (KIDS[parentKey]||[]);
  var ags=pool.filter(function(n){return n.s!=null&&n.e!=null&&passes(n);})
                                   .slice().sort(function(a,b){return a.s-b.s;});
  var out=[], cur=null, until=0;
  ags.forEach(function(n){
   if(!cur||n.s>until){ cur=[]; out.push(cur); until=n.e; }
   else until=Math.max(until,n.e);
   cur.push(n);
  });
  return out;
 }
 function subtreeOf(w){ var c=0; w.forEach(function(n){ c+=subtreeCount(n); }); return c; }
 function subtreeCount(n){
  var c=0; (function w(x){ kidsOf(x).forEach(function(k){ c++; w(k); }); })(n); return c;
 }
 function card(n){
  var sub=kidsOf(n).length, open=!!fopen[n.k]&&!filtering();
  return '<div class="fw-box'+(sub?' has':'')+(open?' open':'')+'" data-k="'+esc(n.k)+'"'+
   ' title="'+esc(tip(n))+'">'+
   '<div class=fw-name>'+(n.cli?'<span class="badge cli">CLI</span>':'')+
    '<span class=a>'+esc(n.a)+'</span><span class=fw-cost>'+usd(n.o)+'</span></div>'+
   '<div class=fw-task>'+esc(n.t||'—')+'</div>'+
   '<div class=fw-meta><span class=fw-model>'+esc(n.m)+
    (n.ef?'<em>'+esc(n.ef)+'</em>':'')+'</span>'+
    '<span>'+dur(n.e-n.s)+'</span><span>'+n.n+' calls</span></div>'+
   '<div class=fw-clock>'+when(n.s,n.e)+'</div>'+
   breakdown(n.tk,n.dl,'fw-bd box')+
   (sub?'<div class=fw-subs><div class=fw-open>'+(open?'▾':'▸')+' '+sub+' subagent'+
     (sub>1?'s':'')+'<b>'+usd(n.c-n.o)+'</b></div>'+
     breakdown(n.TK.map(function(v,i){return v-n.tk[i];}),
               n.DL.map(function(v,i){return v-n.dl[i];}),'fw-bd')+'</div>':'')+'</div>';
 }
 // one level of the flow: its waves, and inline under each open parent, its own
 function level(parentKey,depth){
  var ws=wavesOf(parentKey), out=[], prevEnd=null;
  ws.forEach(function(w,i){
   var s=Math.min.apply(null,w.map(function(n){return n.s;}));
   var e=Math.max.apply(null,w.map(function(n){return n.e;}));
   if(prevEnd!==null) out.push('<div class=fw-gap><span>'+dur(s-prevEnd)+' idle</span></div>');
   prevEnd=e;
   var flat=filtering(), cost=0, tk=[0,0,0,0], dl=[0,0,0,0];
   w.forEach(function(n){ cost+=flat?n.o:n.c;
    for(var j=0;j<4;j++){ tk[j]+=flat?n.tk[j]:n.TK[j]; dl[j]+=flat?n.dl[j]:n.DL[j]; } });
   out.push('<div class=fw-stage><div class=fw-head>'+
    '<b>'+(i+1)+'</b><span class=fw-t>'+dur(e-s)+'</span>'+
    '<span class=fw-when>'+when(s,e)+'</span>'+
    '<span class=fw-n>'+w.length+(w.length>1?' in parallel':' agent')+
     (subtreeOf(w)?' <em>+'+subtreeOf(w)+' nested</em>':'')+'</span>'+
    inline(tk,dl)+
    '<span class=fw-c>'+usd(cost)+'</span></div><div class=fw-boxes>'+
    w.map(function(n){
     return card(n)+(fopen[n.k]&&!filtering()
      ? '<div class=fw-nest><div class=fw-nesthead>subagents of <b>'+esc(n.a)+
        '</b><span>'+subtreeCount(n)+' in total</span><b class=fw-nestc>'+usd(n.c-n.o)+
        '</b></div>'+level(n.k,depth+1)+'</div>' : '');
    }).join('')+'</div></div>');
  });
  return out.join('');
 }
 function drawFlow(){
  var ws=wavesOf(ROOT.k), out=[], agents=NODES.length-1;
  out.push('<div class="fw-stage fw-main"><div class=fw-head>'+
   '<span class=fw-title>'+esc(ROOT.a)+'</span>'+
   '<span class=fw-n>'+(ws.length?'orchestration':'session')+'</span>'+
   '<span class=fw-when>'+when(ROOT.s,ROOT.e)+'</span>'+
   '<span class=fw-t>'+dur(ROOT.e-ROOT.s)+'</span>'+
   inline(ROOT.tk,ROOT.dl)+
   '<span class=fw-c>'+usd(ROOT.o)+'</span></div>'+
   '<div class=fw-mainsub>'+esc(ROOT.m)+(ROOT.ef?' '+esc(ROOT.ef):'')+' · '+ROOT.n+' calls'+
    (ws.length?' — runs from start to finish; this is what it spent itself, '+
     'launching the stages below and handling what came back':'')+'</div></div>');
  if(!ws.length){ out.push('<p class=dim style="padding:.8em .2em">No subagents in this session.</p>');
   document.getElementById('flow').innerHTML=out.join(''); return; }
  out.push('<div class=fw-divider><span>'+agents+' subagent'+(agents>1?'s':'')+
   ', '+ws.length+' stage'+(ws.length>1?'s':'')+' at the top level</span></div>');
  out.push(level(ROOT.k,1));
  var top=0; (KIDS[ROOT.k]||[]).forEach(function(n){ top+=n.c; });
  out.push('<div class=fw-total><span>'+agents+' agents</span>'+
   '<span class=fw-sum>'+usd(ROOT.o)+' <i>main</i> + '+usd(top)+' <i>agents</i> = <b>'+
   usd(ROOT.o+top)+'</b></span></div>');
  document.getElementById('flow').innerHTML=out.join('');
 }
 // ---- breakdown: where the money (or the tokens, or the time) actually went ----
 // main is counted as one more row. It is not a subagent, but it burns real
 // tokens — a quarter of the bill in a typical session — so leaving it out
 // would make every percentage a lie about a smaller whole.
 var MET=[['o','cost'],['t1','out'],['t2','cache read'],['t3','cache write'],
          ['t0','in'],['n','calls'],['ms','agent time']];
 var bdGroup=qs.get('by')==='model'?'model':'agent', bdMetric=qs.get('by2')||'o', bdAll=false;
 function metVal(n,k){
  if(k==='o')return n.o;
  if(k==='n')return n.n;
  if(k==='ms')return (n.e||0)-(n.s||0);
  return n.tk[+k.slice(1)];
 }
 function metFmt(v,k){
  if(k==='o')return usd(v);
  if(k==='n')return v.toLocaleString('en');
  if(k==='ms')return dur(v);
  return kTok(v);
 }
 function drawBreakdown(){
  var by={}, order=[];
  NODES.forEach(function(n){
   var key=bdGroup==='model'?(n.m||'—'):n.a;
   if(!by[key]){ by[key]={k:key,c:0,v:0,root:false,d:[0,0,0,0]}; order.push(key); }
   var g=by[key]; g.c++; g.v+=metVal(n,bdMetric);
   for(var j=0;j<4;j++)g.d[j]+=n.dl[j];
   if(!n.p)g.root=true;
  });
  var rows=order.map(function(k){return by[k];}).sort(function(a,b){return b.v-a.v;});
  bdPaint(document.getElementById('bd'),rows,function(v){return metFmt(v,bdMetric);},
   bdMetric==='o',
   function(tot){ return '<div class=bd-head><b>Breakdown</b>'+
    bdSeg('g',[['agent','by agent'],['model','by model']],bdGroup)+
    bdSeg('m',MET,bdMetric)+'<span class=bd-tot>'+tot+'</span></div>'; },
   false,false);
 }
 document.addEventListener('click',function(e){
  if(!e.target.closest)return;
  var b=e.target.closest('#bd button'); if(!b)return;
  if(b.classList.contains('bd-more'))bdAll=!bdAll;
  else if(b.dataset.g)bdGroup=b.dataset.g; else if(b.dataset.m)bdMetric=b.dataset.m;
  drawBreakdown();
  var u=new URL(location.href);
  bdGroup==='agent'?u.searchParams.delete('by'):u.searchParams.set('by',bdGroup);
  bdMetric==='o'?u.searchParams.delete('by2'):u.searchParams.set('by2',bdMetric);
  history.replaceState(null,'',u);
 });
 function setView(v){
  view=v;
  ['costs','trace','flow'].forEach(function(x){
   document.getElementById('v-'+x).classList.toggle('on',x===v); });
  [].forEach.call(document.querySelectorAll('.tab'),function(b){
   b.classList.toggle('on',b.dataset.v===v); });
  document.getElementById('leg').textContent=v==='costs'
   ? 'collapsed = subtree total · expanded = this agent only'
   : (v==='trace'?'drag across the tracks to zoom':'click an agent to open its subagents');
  if(v==='trace')drawTrace(); if(v==='flow')drawFlow();
  var u=new URL(location.href);
  v==='flow'?u.searchParams.delete('view'):u.searchParams.set('view',v);
  history.replaceState(null,'',u);
 }
 [].forEach.call(document.querySelectorAll('.tab'),function(b){
  b.onclick=function(){ setView(b.dataset.v); }; });
 document.addEventListener('click',function(e){
  if(!e.target.closest)return;
  var r=e.target.closest('.tl-row.has');
  if(r){ var k=r.dataset.k; vopen[k]?delete vopen[k]:vopen[k]=1; drawTrace(); return; }
  if(view!=='flow')return;
  var b=e.target.closest('.fw-box.has'); if(!b)return;
  var k=b.dataset.k; fopen[k]?delete fopen[k]:fopen[k]=1;
  drawFlow();
 });
 drawBreakdown(); index(); order(); paint();
 setView(view);
 // Live sessions refresh in place: swap the table, then put back what the user
 // had — open nodes, sort, filters and scroll position.
 function tick(){
  fetch(location.href,{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){
   if(!h)return;
   var doc=new DOMParser().parseFromString(h,'text/html');
   var nt=doc.querySelector('#tt'),nd=doc.querySelector('.dash'),nh=doc.querySelector('.head');
   if(!nt)return;
   var nn=doc.getElementById('nodes');
   if(nn){ NODES=JSON.parse(nn.textContent); BYK={}; KIDS={};
    NODES.forEach(function(n){ BYK[n.k]=n; (KIDS[n.p||'']=KIDS[n.p||'']||[]).push(n); });
    ROOT=NODES[0];
    var nspan=Math.max((ROOT.e||0)-(ROOT.s||0),1);
    if(TB>=T0+SPAN){ TB=ROOT.s+nspan; }        // keep the window pinned to "now" unless zoomed
    T0=ROOT.s; SPAN=nspan;
    if(view==='trace')drawTrace(); else if(view==='flow')drawFlow();
   }
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
