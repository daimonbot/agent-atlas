import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

type Status = { set: boolean; last4: string | null; sync: { ok: boolean; fetched?: number; cached?: number; message?: string; at: number } | null };
type TestResult = { ok: boolean; status: number; message: string };

const accessToken = new URLSearchParams(location.search).get("t");
async function call(method: string, pathname: string, body?: unknown) {
  const url = new URL(pathname, location.origin);
  if (accessToken) url.searchParams.set("t", accessToken);
  const response = await fetch(url, { method, cache: "no-store", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || response.statusText);
  return data;
}

export function CursorSettings() {
  const queryClient = useQueryClient();
  const status = useQuery<Status>({ queryKey: ["cursor-status"], queryFn: () => call("GET", "/api/cursor/status") as Promise<Status>, refetchInterval: 5_000 });
  const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [result, setResult] = useState<TestResult | null>(null), [error, setError] = useState("");
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); await queryClient.invalidateQueries({ queryKey: ["cursor-status"] }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const save = () => run(async () => { await call("PUT", "/api/cursor/token", { token: value }); setValue(""); setResult(null); });
  const test = () => run(async () => setResult(await call("POST", "/api/cursor/test", value ? { token: value } : {}) as TestResult));
  const remove = () => run(async () => { await call("DELETE", "/api/cursor/token"); setResult(null); });
  const sync = () => run(async () => { await call("POST", "/api/cursor/sync", {}); });
  const data = status.data, last = data?.sync;
  return <details className="cursor-settings"><summary>Cursor {data?.set ? <span className="badge cli">key set · …{data.last4}</span> : <span className="badge done">no key</span>}</summary>
    <div className="cursor-body">
      <p className="muted">Cursor sessions come from Cursor's Admin API (team usage events), not from local files. Paste an Admin API key created by a team admin at cursor.com/dashboard. It is stored on this machine only (mode 0600), sent only to api.cursor.com, and never shown again.</p>
      <div className="toolbar">
        <input type="password" autoComplete="off" aria-label="Cursor API key" placeholder={data?.set ? "paste a new key to replace …" + data.last4 : "Cursor API key"} value={value} onChange={event => setValue(event.target.value)} />
        <button disabled={busy || !value} onClick={save}>Save</button>
        <button disabled={busy || (!value && !data?.set)} onClick={test}>Test connection</button>
        <button disabled={busy || !data?.set} onClick={sync}>Sync now</button>
        <button disabled={busy || !data?.set} onClick={remove}>Remove key</button>
      </div>
      {result && <p role="status" className={result.ok ? "cursor-ok" : "cursor-bad"}>{result.ok ? "OK: " : "Failed: "}{result.message}</p>}
      {error && <p role="alert" className="cursor-bad">{error}</p>}
      {last && <p className="muted" role="status">{last.ok ? `Last sync ${new Date(last.at).toLocaleTimeString()}: ${last.fetched} events fetched, ${last.cached} cached.` : `Last sync failed: ${last.message}`}</p>}
    </div></details>;
}
