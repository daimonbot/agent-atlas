// Cursor usage over Cursor's Admin API, plus the local token store and event cache.
//
// Docs: https://cursor.com/docs/account/teams/admin-api (POST /teams/filtered-usage-events)
//       https://cursor.com/docs/api                     (key types and auth schemes)
//
// Auth is HTTP Basic with the API key as the username and an empty password.
// The key is only ever sent to CURSOR_API_BASE (a constant: no env override, no
// redirects followed), never logged, never returned to a caller of status().
//
// Files, in the config dir (AGENT_ATLAS_CONFIG_DIR or ~/.config/agent-atlas):
//   cursor-token    the key, mode 0600
//   cursor-events   cached usage events (JSON), mode 0600; read synchronously by
//                   providers/cursor.mjs, so discovery never touches the network
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CURSOR_API_BASE = "https://api.cursor.com";
const WINDOW_DAYS = 30;
const MAX_PAGES = 200;

export const configDir = () =>
  process.env.AGENT_ATLAS_CONFIG_DIR || path.join(os.homedir(), ".config", "agent-atlas");
const tokenPath = () => path.join(configDir(), "cursor-token");
export const eventsPath = () => path.join(configDir(), "cursor-events");

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function validateToken(raw) {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token.length < 8 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token))
    throw new Error("that does not look like a Cursor API key");
  return token;
}

export function readToken() {
  try { return fs.readFileSync(tokenPath(), "utf8").trim() || null; } catch { return null; }
}
export function saveToken(raw) { writePrivate(tokenPath(), validateToken(raw) + "\n"); }
export function removeToken() {
  fs.rmSync(tokenPath(), { force: true });
  fs.rmSync(eventsPath(), { force: true });
}

/** All the UI ever learns about the key: whether it is set, and its last 4 characters. */
export function tokenStatus() {
  const token = readToken();
  return token ? { set: true, last4: token.slice(-4) } : { set: false, last4: null };
}

const basic = token => "Basic " + Buffer.from(token + ":").toString("base64");

async function post(fetchImpl, token, route, body) {
  let response;
  try {
    response = await fetchImpl(CURSOR_API_BASE + route, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: basic(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // error.message can carry a URL but never the Authorization header.
    throw Object.assign(new Error("could not reach Cursor's API (" + (error.cause?.code || error.name) + ")"), { status: 0 });
  }
  if (!response.ok) {
    const hint = response.status === 401 ? "Cursor rejected the key (401)"
      : response.status === 403 ? "the key has no access to team usage (403); the Admin API needs a team admin key"
      : response.status === 429 ? "rate limited by Cursor (429); try again in a minute"
      : "Cursor answered " + response.status;
    throw Object.assign(new Error(hint), { status: response.status });
  }
  return response.json();
}

/** Cheap probe: asks for one event in the last hour. */
export async function testConnection(token, fetchImpl = fetch) {
  try {
    const now = Date.now();
    const page = await post(fetchImpl, validateToken(token), "/teams/filtered-usage-events",
      { startDate: now - 3_600_000, endDate: now, page: 1, pageSize: 1 });
    if (!page || !Array.isArray(page.usageEvents)) return { ok: false, status: 200, message: "unexpected response shape from Cursor" };
    return { ok: true, status: 200, message: "Connected. Cursor returned team usage data." };
  } catch (error) { return { ok: false, status: error.status ?? 0, message: error.message }; }
}

export async function fetchUsageEvents(token, { fetchImpl = fetch, now = Date.now(), days = WINDOW_DAYS } = {}) {
  const events = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await post(fetchImpl, token, "/teams/filtered-usage-events",
      { startDate: now - days * 864e5, endDate: now, page, pageSize: 1000 });
    if (!body || !Array.isArray(body.usageEvents)) throw new Error("unexpected response shape from Cursor");
    events.push(...body.usageEvents);
    if (!body.pagination?.hasNextPage) break;
  }
  return events;
}

const eventKey = e => [e.timestamp, e.userEmail, e.model, e.conversationId || "", e.tokenUsage?.inputTokens ?? "", e.tokenUsage?.outputTokens ?? ""].join("|");

export function readCachedEvents() {
  try { const data = JSON.parse(fs.readFileSync(eventsPath(), "utf8")); return Array.isArray(data.events) ? data.events : []; }
  catch { return []; }
}

/** Fetch the last 30 days and merge into the cache, so history accumulates beyond the window. */
export async function syncCursor({ fetchImpl = fetch, now = Date.now() } = {}) {
  const token = readToken();
  if (!token) return { ok: false, message: "no Cursor key set" };
  try {
    const fresh = await fetchUsageEvents(token, { fetchImpl, now });
    const merged = new Map(readCachedEvents().map(e => [eventKey(e), e]));
    for (const e of fresh) merged.set(eventKey(e), e);
    const events = [...merged.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    writePrivate(eventsPath(), JSON.stringify({ syncedAt: now, events }));
    return { ok: true, fetched: fresh.length, cached: events.length, syncedAt: now };
  } catch (error) { return { ok: false, message: error.message }; }
}
