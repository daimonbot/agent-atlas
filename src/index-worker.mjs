import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import * as providers from "./providers/index.mjs";
import { describe, workspace } from "./providers/index.mjs";
import { LIVE_MS, toSessionRow } from "./session-index.mjs";

const parserCache = new Map();
const summaries = new Map();
let lastSignature = "", lastRows = [];
const sessionFolder = file => typeof file === "string" ? file.replace(/\.jsonl$/, "") : null;
function fingerprint(file) {
  const entries = [], files = [];
  const visit = target => {
    let stat; try { stat = fs.statSync(target); } catch { return; }
    if (stat.isDirectory()) { for (const child of fs.readdirSync(target).sort()) visit(path.join(target, child)); return; }
    files.push(target); entries.push(target + ":" + stat.size + ":" + stat.mtimeMs);
  };
  visit(file); visit(sessionFolder(file)); return { stamp: entries.join("|"), files };
}
function scan() {
  const now = Date.now();
  const sessions = providers.discover().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keyOf = session => `${session.provider}:${session.id}`;
  const active = new Set(sessions.map(keyOf)), activeFiles = new Set();
  for (const id of summaries.keys()) if (!active.has(id)) summaries.delete(id);
  const rows = sessions.map(session => {
    const key = keyOf(session), fingerprinted = fingerprint(session.path); fingerprinted.files.forEach(file => activeFiles.add(file)); const stamp = fingerprinted.stamp || `${session.mtimeMs}:${session.size}`; const previous = summaries.get(key);
    if (previous && previous.path === session.path && previous.stamp === stamp) return { ...previous.row, live: now - session.mtimeMs < LIVE_MS };
    const row = toSessionRow(session, providers.buildTree(session, parserCache), now);
    summaries.set(key, { ref: session, path: session.path, stamp, row }); return row;
  });
  for (const key of parserCache.keys()) if (!activeFiles.has(key)) parserCache.delete(key);
  const signature = rows.map(row => row.id + ":" + (summaries.get(row.id)?.stamp || "") + ":" + Number(row.live)).join("|");
  const changed = signature !== lastSignature; if (changed) { lastSignature = signature; lastRows = rows; }
  return { rows: changed ? rows : lastRows, scannedAt: now, changed };
}
function detail(id) {
  const record = [...summaries.values()].find(x => x.ref.id === id || x.ref.id.startsWith(id));
  if (!record) return null;
  const tree = providers.buildTree(record.ref, parserCache); const mtime = record.ref.mtimeMs;
  return { live: Date.now() - mtime < LIVE_MS, describe: describe(tree), workspace: workspace(tree), tree };
}
parentPort.on("message", ({ type, requestId, id }) => {
  try { const value = type === "scan" ? scan() : type === "detail" ? detail(id) : null; parentPort.postMessage({ requestId, ok: true, value }); }
  catch (error) { parentPort.postMessage({ requestId, ok: false, error: error.message }); }
});
