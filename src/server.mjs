// HTTP server: React/Vite shell plus an isolated transcript-index worker.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { querySessions } from "./session-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8" };
const CACHE_LIMIT = 64;

export function serve({ host = "127.0.0.1", port = 4747, intervalS = 10, token = null } = {}) {
  let rows = [], revision = 0, scannedAt = 0, scanError = null, indexing = true, scanQueued = false, scanActive = false;
  const worker = new Worker(new URL("./index-worker.mjs", import.meta.url));
  let nextRequest = 1; const pending = new Map(), queryCache = new Map();
  const workerCall = (type, payload = {}) => new Promise((resolve, reject) => { const requestId = nextRequest++; pending.set(requestId, { resolve, reject }); worker.postMessage({ type, requestId, ...payload }); });
  worker.on("message", message => { const request = pending.get(message.requestId); if (!request) return; pending.delete(message.requestId); message.ok ? request.resolve(message.value) : request.reject(new Error(message.error || "index worker failed")); });
  worker.on("error", error => { scanError = error.message; indexing = false; for (const request of pending.values()) request.reject(error); pending.clear(); });
  const runScan = async () => { if (scanActive) { scanQueued = true; return; } scanActive = true; indexing = true; try { const result = await workerCall("scan"); scannedAt = result.scannedAt; if (result.changed) { rows = result.rows; revision++; queryCache.clear(); } scanError = null; } catch (error) { scanError = error.message; } finally { scanActive = false; indexing = false; if (scanQueued) { scanQueued = false; runScan(); } } };
  const timer = setInterval(runScan, Math.max(intervalS, 1) * 1000); timer.unref?.();
  const send = (res, code, type, body, extra = {}) => res.writeHead(code, { "content-type": type, "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra }).end(body);
  const json = (res, code, body) => send(res, code, "application/json; charset=utf-8", JSON.stringify(body));
  const allowed = url => !token || url.searchParams.get("t") === token;
  const status = () => ({ complete: !indexing, scannedAt, error: scanError, revision, discovered: rows.length });
  const shell = () => { const file = path.join(DIST, "index.html"); return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null; };
  const staticFile = pathname => { const file = path.resolve(DIST, pathname.replace(/^\/+/, "")); return file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null; };
  const cacheResult = (key, make) => { if (queryCache.has(key)) return queryCache.get(key); const value = make(); queryCache.set(key, value); if (queryCache.size > CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value); return value; };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://agent-atlas.local"); if (!allowed(url) && !url.pathname.startsWith("/assets/")) return send(res, 403, "text/plain; charset=utf-8", "forbidden");
    try {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, ...status() });
      if (url.pathname === "/api/sessions") return json(res, 200, rows);
      const treeMatch = url.pathname.match(/^\/api\/tree\/([0-9a-f-]+)$/), uiMatch = url.pathname.match(/^\/api\/ui\/session\/([0-9a-f-]+)$/);
      if (treeMatch || uiMatch) { const detail = await workerCall("detail", { id: (treeMatch || uiMatch)[1] }); return detail ? json(res, 200, treeMatch ? detail.tree : { revision, ...detail }) : send(res, 404, "text/plain; charset=utf-8", "unknown session"); }
      if (url.pathname === "/api/ui/sessions") { const requestedRevision = url.searchParams.get("revision"); if (requestedRevision && Number(requestedRevision) !== revision) return json(res, 409, { error: "revision-expired", revision }); try { const params = Object.fromEntries(url.searchParams); const key = revision + "?" + JSON.stringify(params); const immutable = cacheResult(key, () => querySessions(rows, params)); return json(res, 200, { revision, indexing: status(), totalOnDisk: rows.length, ...immutable }); } catch (error) { return json(res, 400, { error: error.message }); } }
      const asset = url.pathname.startsWith("/assets/") ? staticFile(url.pathname) : null; if (asset) return send(res, 200, MIME[path.extname(asset)] || "application/octet-stream", fs.readFileSync(asset), { "cache-control": "public, max-age=31536000, immutable" });
      if (url.pathname === "/" || /^\/session\/[0-9a-f-]+$/.test(url.pathname)) { const html = shell(); return html ? send(res, 200, "text/html; charset=utf-8", html) : send(res, 503, "text/plain; charset=utf-8", "UI build missing; run npm run build"); }
      send(res, 404, "text/plain; charset=utf-8", "not found");
    } catch (error) { send(res, 500, "text/plain; charset=utf-8", "error: " + error.message); }
  });
  srv.on("close", () => { clearInterval(timer); worker.terminate(); });
  srv.listen(port, host, () => { console.log(`agent-atlas listening on http://${host}:${port}/ (scan every ${intervalS}s; indexing in background)`); setImmediate(runScan); }); return srv;
}
