import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueries, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import "./ui.css";
import { SessionDetail } from "./ui/session-view";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });
const token = new URLSearchParams(location.search).get("t");
const api = async (pathname, params = {}) => {
  const url = new URL(pathname, location.origin);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "" && value !== false) url.searchParams.set(key, String(value));
  if (token) url.searchParams.set("t", token);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) { const error = new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || response.statusText) as Error & { status?: number }; error.status = response.status; if (response.status === 409) window.dispatchEvent(new Event("atlas-revision-expired")); throw error; }
  return response.json();
};
const money = value => value == null ? "—" : value > 0 && value < .01 ? "\$" + value.toFixed(4) : "\$" + value.toFixed(2);
const num = value => Number(value || 0).toLocaleString("en");
const duration = value => value == null ? "" : value >= 3600 ? (value / 3600).toFixed(1) + "h" : value >= 60 ? Math.round(value / 60) + "m" : value + "s";
const tokenCount = value => value >= 1e6 ? (value / 1e6).toFixed(1) + "M" : value >= 1e3 ? (value / 1e3).toFixed(0) + "k" : num(value);
const shortDate = value => value ? value.slice(5, 16).replace("T", " ") : "";
const linkTo = pathname => pathname + (token ? "?t=" + encodeURIComponent(token) : "");
const sessionParams = (filters, extra = {}) => { const implicitFrom = !filters.from && filters.range !== "30" ? (filters.range === "0" ? "1970-01-01" : new Date(Date.now() - Number(filters.range) * 864e5).toISOString().slice(0, 10)) : filters.from; return { ...filters, from: implicitFrom, live: filters.live ? "1" : "", usemin: filters.usemin ? "1" : "0", ...extra }; };

function readFilters() {
  const search = new URLSearchParams(location.search); const legacyColumns = ["title", "title", "project", "start", "duration", "agentMs", "agents", "calls", "humanMsgs", "in", "out", "cr", "cw", "cost"];
  const legacyMetric = { n: "sessions", hm: "humanMsgs", dur: "duration", ams: "agentMs" };
  const range = search.get("r") ?? "30";
  return { q: search.get("q") || "", project: search.get("project") || search.get("p") || "", model: search.get("model") || search.get("m") || "", live: (search.get("live") || "") === "1", usemin: (search.get("usemin") ?? search.get("min") ?? "1") !== "0", minCost: search.get("minCost") || search.get("minv") || ".5", from: search.get("from") || "", to: search.get("to") || "", range, sort: search.get("sort") || (search.has("c") ? legacyColumns[Number(search.get("c"))] : null) || "start", dir: search.get("dir") || search.get("d") || "desc", by: search.get("by") || "project", metric: legacyMetric[search.get("metric") || search.get("by2")] || search.get("metric") || search.get("by2") || "cost" };
}
function writeFilters(filters) {
  const next = new URL(location.href); ["q", "project", "model", "from", "to", "sort", "dir", "by", "metric", "minCost", "c", "d", "p", "m", "min", "minv", "r", "by2", "range"].forEach(key => next.searchParams.delete(key));
  next.searchParams.delete("live"); next.searchParams.delete("usemin");
  for (const [key, value] of Object.entries(filters)) {
    if ((key === "range" && value === "30") || (key === "sort" && value === "start") || (key === "dir" && value === "desc") || (key === "metric" && value === "cost") || (key === "usemin" && value) || value === "" || (value === false && key !== "usemin")) continue;
    next.searchParams.set(key === "range" ? "r" : key, key === "usemin" ? (value ? "1" : "0") : (value === true ? "1" : String(value)));
  }
  history.replaceState(null, "", next); window.dispatchEvent(new Event("atlas-url"));
}

function MetricGrid({ summary }) {
  const token = summary.token || {}, tokenCost = summary.tokenCost || {};
  const items = [["total cost", money(summary.cost), num(summary.sessions) + " sessions"], ["avg / session", money(summary.average), "median " + money(summary.median)], ["human messages", num(summary.humanMsgs), money(summary.costPerHumanMsg) + "/msg · " + (summary.callsPerHumanMsg || 0).toFixed(1) + " calls/msg"], ["agents", num(summary.agents), num(summary.calls) + " API calls · " + duration(Math.round(summary.agentMs / 1000)) + " agent time"], ["input", tokenCount(token.in), money(tokenCost.in)], ["output", tokenCount(token.out), money(tokenCost.out)], ["cache read", tokenCount(token.cr), money(tokenCost.cr)], ["cache write", tokenCount(token.cw), money(tokenCost.cw)]];
  return <div className="dash">{items.map(([label, value, sub], index) => <div className={"tile " + (index === 0 ? "lead" : "")} key={label}><span className="lbl">{label}</span><b>{value}</b><span className="sub">{sub}</span></div>)}</div>;
}
function Filters({ filters, facets, onChange }) {
  const change = (key, value) => onChange({ ...filters, [key]: value });
  const range = value => onChange({ ...filters, range: value, from: "", to: "" });
  return <div className="toolbar"><input aria-label="Search sessions" placeholder="search session, project, task…" value={filters.q} onChange={event => change("q", event.target.value)} />
    <select aria-label="Project" value={filters.project} onChange={event => change("project", event.target.value)}><option value="">all projects</option>{facets.projects.map(value => <option key={value}>{value}</option>)}</select>
    <select aria-label="Model" value={filters.model} onChange={event => change("model", event.target.value)}><option value="">all models</option>{facets.models.map(value => <option key={value}>{value}</option>)}</select>
    <label><input type="checkbox" checked={filters.live} onChange={event => change("live", event.target.checked)} /> live only</label>
    <label><input type="checkbox" checked={filters.usemin} onChange={event => change("usemin", event.target.checked)} /> min $<input type="number" min="0" step=".05" disabled={!filters.usemin} value={filters.minCost} onChange={event => change("minCost", event.target.value)} /></label>
    <span className="rng">{[["1", "24h"], ["7", "7d"], ["30", "30d"], ["90", "90d"], ["365", "1y"], ["0", "all"]].map(([value, label]) => <button className={"rbtn " + (!filters.from && !filters.to && filters.range === value ? "on" : "")} onClick={() => range(value)} key={value}>{label}</button>)}</span>
    <label className="dates">from <input type="date" value={filters.from} onChange={event => change("from", event.target.value)} /> to <input type="date" value={filters.to} onChange={event => change("to", event.target.value)} /></label></div>;
}
function Breakdown({ rows, filters, onChange }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0) || 1;
  return <section className="bd"><div className="bd-head"><b>Breakdown</b><div className="seg"><button className={filters.by === "project" ? "on" : ""} onClick={() => onChange({ ...filters, by: "project" })}>by project</button><button className={filters.by === "agent" ? "on" : ""} onClick={() => onChange({ ...filters, by: "agent" })}>by agent</button><button className={filters.by === "model" ? "on" : ""} onClick={() => onChange({ ...filters, by: "model" })}>by model</button></div><div className="seg">{["cost", "out", "cr", "cw", "in", "sessions", "agents", "calls", "humanMsgs", "duration", "agentMs"].map(metric => <button key={metric} className={filters.metric === metric ? "on" : ""} onClick={() => onChange({ ...filters, metric })}>{metric === "agentMs" ? "time" : metric}</button>)}</div></div><div className="bd-rows">{rows.slice(0, 12).map(row => <div className="bd-row" key={row.key}><span className="bd-name">{row.key}<i>×{row.count}</i></span><span className="bd-bar"><i style={{ width: (row.value / total * 100) + "%" }} /></span><span className="bd-val">{filters.metric === "cost" ? money(row.value) : filters.metric === "agentMs" ? duration(Math.round(row.value / 1000)) : (["calls", "sessions", "agents", "humanMsgs"].includes(filters.metric) ? num(row.value) : ["agentMs", "duration"].includes(filters.metric) ? duration(Math.round(row.value / (filters.metric === "duration" ? 1 : 1000))) : tokenCount(row.value))}</span></div>)}</div></section>;
}
function SortHeader({ label, field, filters, onChange, numeric = false }) { const active = filters.sort === field; return <th className={"s " + (numeric ? "r" : "")} onClick={() => onChange({ ...filters, sort: field, dir: active && filters.dir === "desc" ? "asc" : "desc" })}>{label}<span className="arr">{active ? filters.dir === "desc" ? "▼" : "▲" : "⇅"}</span></th>; }
function SessionRow({ row }) { const token = row.tokens || {}, tokenCost = row.tokenCost || {}, workspace = row.workspace || {}; const metric = key => <td className={"r " + (!token[key] ? "zero" : "")} key={key}>{token[key] ? <>{tokenCount(token[key])}<span className="usd">{money(tokenCost[key])}</span></> : "·"}</td>; return <tr><td className="l">{row.live ? <span className="badge live">LIVE</span> : <span className="badge done">closed</span>}</td><td className="l ag"><div className="agl"><a href={linkTo("/session/" + row.id)}>{row.title || row.name || row.project}</a></div><div className="agd"><span className="mono">{row.id.slice(0, 8)}</span>{row.subtitle || row.desc ? " · " + (row.subtitle || row.desc) : ""}</div></td><td className="l proj" title={workspace.cwd || ""}><div className="m1">{workspace.label || row.project}</div><div className="m2">{workspace.branch ? "⎇ " + workspace.branch : ""}</div></td><td className="dim mono">{shortDate(row.start)}</td><td className="r dim">{duration(row.durationS)}</td><td className="r dim">{row.agentMs ? duration(Math.round(row.agentMs / 1000)) : "·"}</td><td className="r dim">{num(row.agents)}</td><td className="r dim">{num(row.apiCalls)}</td><td className="r dim">{num(row.humanMsgs)}{row.costPerHumanMsg != null && <span className="usd">{money(row.costPerHumanMsg)}/msg</span>}</td>{["in", "out", "cr", "cw"].map(metric)}<td className="r money">{money(row.cost)}</td></tr>; }
function VirtualSessionTable({ filters, onChange, data }) {
  const parentRef = useRef(null); const virtual = useVirtualizer({ count: data?.matchedCount || 0, getScrollElement: () => parentRef.current, estimateSize: () => 58, overscan: 8 });
  const virtualItems = virtual.getVirtualItems();
  const offsets = [...new Set((virtualItems.length ? virtualItems : [{ index: 0 }]).map(item => Math.floor(item.index / 100) * 100))];
  const pages = useQueries({ queries: offsets.map(offset => ({ queryKey: ["sessions-range", filters, data?.revision, offset], queryFn: () => api("/api/ui/sessions", sessionParams(filters, { offset, limit: 100, revision: data?.revision })) })) });
  const pageRows = new Map(); pages.forEach((page, pageIndex) => page.data?.rows.forEach((row, index) => pageRows.set(offsets[pageIndex] + index, row)));
  const top = virtualItems[0]?.start || 0, bottom = Math.max(0, virtual.getTotalSize() - (virtualItems.at(-1)?.end || 0));
  return <div className="table-scroll" ref={parentRef}><table className="tt"><thead><tr><SortHeader label="status" field="live" filters={filters} onChange={onChange} /><SortHeader label="session" field="title" filters={filters} onChange={onChange} /><SortHeader label="project" field="project" filters={filters} onChange={onChange} /><SortHeader label="started" field="start" filters={filters} onChange={onChange} /><SortHeader label="dur" field="duration" filters={filters} onChange={onChange} numeric /><SortHeader label="agent time" field="agentMs" filters={filters} onChange={onChange} numeric /><SortHeader label="agents" field="agents" filters={filters} onChange={onChange} numeric /><SortHeader label="calls" field="calls" filters={filters} onChange={onChange} numeric /><SortHeader label="human messages" field="humanMsgs" filters={filters} onChange={onChange} numeric /><SortHeader label="in" field="in" filters={filters} onChange={onChange} numeric /><SortHeader label="out" field="out" filters={filters} onChange={onChange} numeric /><SortHeader label="cache read" field="cr" filters={filters} onChange={onChange} numeric /><SortHeader label="cache write" field="cw" filters={filters} onChange={onChange} numeric /><SortHeader label="cost" field="cost" filters={filters} onChange={onChange} numeric /></tr></thead><tbody>{top > 0 && <tr aria-hidden="true"><td colSpan={14} style={{ height: top, padding: 0 }} /></tr>}{virtualItems.map(item => { const row = pageRows.get(item.index); return row ? <SessionRow key={row.id} row={row} /> : <tr key={item.index} className="skeleton"><td colSpan={14}>Loading session…</td></tr>; })}{bottom > 0 && <tr aria-hidden="true"><td colSpan={14} style={{ height: bottom, padding: 0 }} /></tr>}</tbody></table></div>;
}
function SessionsPage() {
  const [filters, setFilters] = useState(readFilters); const [generation, setGeneration] = useState(0); const delayed = useDeferredValue(filters);
  useEffect(() => { const update = () => setFilters(readFilters()); const expired = () => setGeneration(value => value + 1); addEventListener("atlas-url", update); addEventListener("popstate", update); addEventListener("atlas-revision-expired", expired); return () => { removeEventListener("atlas-url", update); removeEventListener("popstate", update); removeEventListener("atlas-revision-expired", expired); }; }, []);
  const update = next => { setFilters(next); writeFilters(next); };
  const query = useQuery({ queryKey: ["sessions-root", delayed, generation], queryFn: () => api("/api/ui/sessions", sessionParams(delayed, { offset: 0, limit: 100 })), refetchInterval: state => state.state.data?.indexing?.complete ? 45_000 : 500 });
  if (query.isLoading) return <main><header className="head"><h1>agent-atlas</h1><p className="muted">Indexing sessions…</p></header></main>;
  if (query.error) return <main><ErrorMessage error={query.error} /></main>;
  const data = query.data, summary = { ...data.summary, sessions: data.matchedCount };
  return <main><header className="head"><h1>agent-atlas</h1><p className="muted">cost & agent-tree explorer <span className="dim">· {data.indexing.complete ? data.totalOnDisk + " sessions indexed" : "indexing " + data.indexing.discovered + " sessions"}</span></p></header><MetricGrid summary={summary} /><Filters filters={filters} facets={data.facets} onChange={update} /><Breakdown rows={data.breakdown} filters={filters} onChange={update} /><VirtualSessionTable filters={delayed} onChange={update} data={data} /></main>;
}
function SessionPage({ id }) { const query = useQuery({ queryKey: ["session", id], queryFn: () => api("/api/ui/session/" + id), refetchInterval: value => value.state.data?.live ? 10_000 : false });
  if (query.isLoading) return <main><p className="muted">Loading session…</p></main>;
  if (query.error) return <main><ErrorMessage error={query.error} /></main>;
  const data = query.data; return <SessionDetail tree={data.tree} info={data.describe} workspace={data.workspace} live={data.live} backHref={linkTo("/")} />;
}
function ErrorMessage({ error }) { return <section className="error"><h1>Could not load agent-atlas</h1><p>{error.message}</p><button onClick={() => location.reload()}>Retry</button></section>; }
function App() { const match = location.pathname.match(/^\/session\/([0-9a-f-]+)$/); return match ? <SessionPage id={match[1]} /> : <SessionsPage />; }
createRoot(document.getElementById("root")).render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
