import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import * as claude from "./providers/claude.mjs";
import { describe, workspace } from "./providers/claude.mjs";
import { LIVE_MS, toSessionRow } from "./session-index.mjs";

const parserCache = new Map();
const summaries = new Map();
let lastSignature = "", lastRows = [];
const sessionFolder = file => file.replace(/\.jsonl$/, "");
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
  const sessions = claude.discover().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const active = new Set(sessions.map(session => session.id)), activeFiles = new Set();
  for (const id of summaries.keys()) if (!active.has(id)) summaries.delete(id);
  const rows = sessions.map(session => {
    const fingerprinted = fingerprint(session.path); fingerprinted.files.forEach(file => activeFiles.add(file)); const stamp = fingerprinted.stamp; const previous = summaries.get(session.id);
    if (previous && previous.path === session.path && previous.stamp === stamp) return { ...previous.row, live: now - session.mtimeMs < LIVE_MS };
    const row = toSessionRow(session, claude.buildTree(session.path, parserCache), now);
    summaries.set(session.id, { path: session.path, stamp, row }); return row;
  });
  for (const key of parserCache.keys()) if (!activeFiles.has(key)) parserCache.delete(key);
  const signature = rows.map(row => row.id + ":" + (summaries.get(row.id)?.stamp || "") + ":" + Number(row.live)).join("|");
  const changed = signature !== lastSignature; if (changed) { lastSignature = signature; lastRows = rows; }
  return { rows: changed ? rows : lastRows, scannedAt: now, changed };
}
function detail(id) {
  const record = summaries.get(id) || [...summaries.entries()].find(([key]) => key.startsWith(id))?.[1];
  if (!record) return null;
  const tree = claude.buildTree(record.path, parserCache); const mtime = fs.statSync(record.path).mtimeMs;
  return { live: Date.now() - mtime < LIVE_MS, describe: describe(tree), workspace: workspace(tree), tree };
}
parentPort.on("message", ({ type, requestId, id }) => {
  try { const value = type === "scan" ? scan() : type === "detail" ? detail(id) : null; parentPort.postMessage({ requestId, ok: true, value }); }
  catch (error) { parentPort.postMessage({ requestId, ok: false, error: error.message }); }
});
