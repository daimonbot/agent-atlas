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
import crypto from "node:crypto";
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

// The directory must be ours: refuse one owned by someone else, tighten ours to 0700.
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()))
    throw new Error("config directory " + dir + " is not a directory owned by this user");
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}
// Random temp name created with O_EXCL (never opens an existing file or follows a
// symlink), then renamed over the target.
function writePrivate(file, text) {
  privateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + crypto.randomBytes(8).toString("hex") + ".tmp");
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

// Bumped whenever the credential changes; a sync that started under an older
// generation drops its result instead of writing it.
let generation = 0;
const fingerprint = token => crypto.createHash("sha256").update(token).digest("hex");

export function validateToken(raw) {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token.length < 8 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token))
    throw new Error("that does not look like a Cursor API key");
  return token;
}

export function readToken() {
  try { return fs.readFileSync(tokenPath(), "utf8").trim() || null; } catch { return null; }
}
export function saveToken(raw) {
  const token = validateToken(raw), previous = readToken();
  writePrivate(tokenPath(), token + "\n");
  generation++;
  // Another key may be another team: its events must never merge with the old cache.
  if (previous !== token) fs.rmSync(eventsPath(), { force: true });
}
export function removeToken() {
  generation++;
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

export async function fetchUsageEvents(token, { fetchImpl = fetch, now = Date.now(), days = WINDOW_DAYS, maxPages = MAX_PAGES } = {}) {
  const events = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const body = await post(fetchImpl, token, "/teams/filtered-usage-events",
      { startDate: now - days * 864e5, endDate: now, page, pageSize: 1000 });
    if (!body || !Array.isArray(body.usageEvents)) throw new Error("unexpected response shape from Cursor");
    events.push(...body.usageEvents);
    if (!body.pagination?.hasNextPage) break;
    if (page === maxPages) truncated = true;
  }
  return { events, truncated };
}

const eventKey = e => [e.timestamp, e.userEmail, e.model, e.conversationId || "", e.tokenUsage?.inputTokens ?? "", e.tokenUsage?.outputTokens ?? ""].join("|");

export function readCache() {
  try { const data = JSON.parse(fs.readFileSync(eventsPath(), "utf8")); return { events: Array.isArray(data.events) ? data.events : [], truncated: !!data.truncated, fingerprint: data.fingerprint || null }; }
  catch { return { events: [], truncated: false, fingerprint: null }; }
}
export const readCachedEvents = () => readCache().events;

/** Fetch the last 30 days and merge into the cache, so history accumulates beyond the window. */
export async function syncCursor({ fetchImpl = fetch, now = Date.now(), maxPages = MAX_PAGES } = {}) {
  const token = readToken();
  if (!token) return { ok: false, message: "no Cursor key set" };
  const started = generation, print = fingerprint(token);
  try {
    const { events: fresh, truncated } = await fetchUsageEvents(token, { fetchImpl, now, maxPages });
    if (started !== generation) return { ok: false, message: "the key changed during the sync; result discarded" };
    const cache = readCache();
    const merged = new Map((cache.fingerprint === print ? cache.events : []).map(e => [eventKey(e), e]));
    for (const e of fresh) merged.set(eventKey(e), e);
    const events = [...merged.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    writePrivate(eventsPath(), JSON.stringify({ syncedAt: now, fingerprint: print, truncated, events }));
    return { ok: true, fetched: fresh.length, cached: events.length, syncedAt: now, truncated };
  } catch (error) { return { ok: false, message: error.message }; }
}
