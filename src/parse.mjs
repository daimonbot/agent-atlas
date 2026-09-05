// Incremental parser for one Claude Code transcript file (JSONL, append-only).
// Safe under live sessions: reads from a byte offset, keeps partial trailing
// lines for the next pass, and aggregation is idempotent (dedup by message.id
// keeping the MAX-usage variant, which is how the harness resolves its own
// streaming duplicates). Re-parsing any range converges to the same numbers.
import fs from "node:fs";
import { priceClaude } from "./prices.mjs";

export class SessionFileParser {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.tail = "";            // partial last line
    this.seen = new Map();     // message.id -> {tot, u, model, ts}
    this.models = new Set();
    this.efforts = new Set();
    this.first = null; this.last = null;
    this.userMsgs = 0;
    this.toolUseIds = new Set();       // tool_use ids seen (spawn attachment)
    this.firstPrompt = null;           // first real user prompt (session description)
    this.summary = null;               // harness-written summary record, if any
    this.skills = [];                  // skills invoked, in first-seen order
    this.branches = new Set();         // git branches seen (minus HEAD)
    this.identity = {};                // agent-name / custom-title / agent-setting
    this.codexCalls = new Map();       // tool_use.id -> its record's timestamp (codex-looking Bash)
    this.codexSessions = new Map();    // lowercased codex session uuid -> detection record
    this.size = -1; this.mtimeMs = -1;
  }

  /** Parse any new bytes. Returns true if something changed. */
  update() {
    let st;
    try { st = fs.statSync(this.path); } catch { return false; }
    if (st.size === this.size && st.mtimeMs === this.mtimeMs) return false;
    if (st.size < this.offset) {           // truncated/replaced: full reset
      this.offset = 0; this.tail = ""; this.seen.clear();
      this.models.clear(); this.efforts.clear();
      this.first = this.last = null; this.userMsgs = 0;
      this.toolUseIds.clear(); this.identity = {};
      this.firstPrompt = null; this.summary = null;
      this.skills = []; this.branches = new Set();
      this.codexCalls.clear(); this.codexSessions.clear();
    }
    const fd = fs.openSync(this.path, "r");
    try {
      const len = st.size - this.offset;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        this.offset = st.size;
        const chunk = this.tail + buf.toString("utf8");
        const lines = chunk.split("\n");
        this.tail = lines.pop();           // may be partial; kept for next pass
        for (const line of lines) this.#line(line);
      }
    } finally { fs.closeSync(fd); }
    this.size = st.size; this.mtimeMs = st.mtimeMs;
    return true;
  }

  #line(line) {
    if (!line.trim()) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.timestamp) {
      if (!this.first || o.timestamp < this.first) this.first = o.timestamp;
      if (!this.last  || o.timestamp > this.last)  this.last  = o.timestamp;
    }
    if (o.effort) this.efforts.add(o.effort);
    if (o.type === "summary" && o.summary) this.summary = o.summary;
    if (o.gitBranch && o.gitBranch !== "HEAD") this.branches.add(o.gitBranch);
    if (o.type === "agent-name")   this.identity.agentName   = o.agentName;
    if (o.type === "custom-title") this.identity.customTitle = o.customTitle;
    if (o.type === "agent-setting")this.identity.agentSetting= o.agentSetting;
    const m = o.message; if (!m) return;
    if (m.model) this.models.add(m.model);
    const c = m.content;
    if (o.type === "user" && (typeof c === "string" ||
        (Array.isArray(c) && c.some(b => b.type === "text") && !c.some(b => b.type === "tool_result")))) {
      this.userMsgs++;
      if (!this.firstPrompt) {
        const txt = (typeof c === "string" ? c
          : c.filter(b => b.type === "text").map(b => b.text).join(" ")).trim();
        if (txt && !txt.startsWith("<") && !txt.startsWith("Base directory for this skill")
            && !txt.startsWith("[Request interrupted"))
          this.firstPrompt = txt.replace(/\s+/g, " ").slice(0, 500);
      }
      const t0 = (typeof c === "string" ? c : c.filter(b => b.type === "text").map(b => b.text).join(" ")).trim();
      if (t0.startsWith("Base directory for this skill: "))
        this.#skill(t0.split("\n")[0].split("/").pop());
    }
    if (Array.isArray(c))
      for (const b of c) {
        if (b.type === "tool_use") {
          this.toolUseIds.add(b.id);
          if (b.name === "Skill" && b.input?.skill) this.#skill(b.input.skill);
          if (b.name === "Bash" && isCodexCommand(b.input?.command))
            this.codexCalls.set(b.id, o.timestamp || null);
        } else if (b.type === "tool_result" && this.codexCalls.has(b.tool_use_id)) {
          // Gate order is the cheap-common-case mechanism: an O(1) lookup on a map
          // that is empty for almost every transcript, then a substring pre-check,
          // and only then (inside #codex) any regex at all.
          const text = codexResultText(b.content);
          if (text.includes("session id:"))
            this.#codex(text, this.codexCalls.get(b.tool_use_id), o.timestamp || null);
        }
      }
    if (m.usage && m.id) {
      const u0 = m.usage;
      const u = { in: u0.input_tokens || 0, out: u0.output_tokens || 0,
        cr: u0.cache_read_input_tokens || 0,
        c5:  (u0.cache_creation || {}).ephemeral_5m_input_tokens || 0,
        c1h: (u0.cache_creation || {}).ephemeral_1h_input_tokens || 0 };
      const tot = u.in + u.out + u.cr + u.c5 + u.c1h;
      const prev = this.seen.get(m.id);
      if (!prev || tot > prev.tot) this.seen.set(m.id, { tot, u, model: m.model, ts: o.timestamp });
    }
  }

  #skill(name) { if (name && !this.skills.includes(name)) this.skills.push(name); }

  /** One detection per `session id:` line; keep the best record per uuid (see codexBetter). */
  #codex(text, start, end) {
    for (const r of codexDetections(text, start, end)) {
      const prev = this.codexSessions.get(r.sessionId);
      if (!prev || codexBetter(r, prev)) this.codexSessions.set(r.sessionId, r);
    }
  }

  aggregates() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    let usd = 0; let confidence = "verified"; const unknown = new Set();
    for (const [, v] of this.seen) {
      t.input += v.u.in; t.output += v.u.out; t.cacheRead += v.u.cr;
      t.cacheWrite5m += v.u.c5; t.cacheWrite1h += v.u.c1h;
      const r = priceClaude(v.model, v.ts, v.u);
      usd += r.usd;
      if (r.unknownModel) unknown.add(r.unknownModel);
      if (r.confidence === "computed" && confidence === "verified") confidence = "computed";
    }
    return {
      model: [...this.models], effort: [...this.efforts],
      start: this.first, end: this.last,
      durationS: this.first && this.last ? Math.round((new Date(this.last) - new Date(this.first)) / 1000) : null,
      apiCalls: this.seen.size, userMsgs: this.userMsgs,
      firstPrompt: this.firstPrompt, summary: this.summary,
      skills: [...this.skills], branch: [...this.branches][0] || null,
      tokens: t, costOwn: usd, costConfidence: unknown.size ? "partial" : confidence,
      unknownModels: [...unknown], identity: this.identity,
      codex: [...this.codexSessions.values()],
    };
  }
}

// ---------------------------------------------------------------------------
// Codex-launch detection inside a Bash tool_result's text. A tool_result block
// carries only {tool_use_id,type,content,is_error} -- no tool name, no command --
// so the launching tool_use has to be remembered (this.codexCalls), and the pair
// can straddle two incremental passes. Everything below is pure, module-private.
// ---------------------------------------------------------------------------

/** A Bash call is codex-looking iff its command mentions codex anywhere. */
const isCodexCommand = cmd => typeof cmd === "string" && /codex/i.test(cmd);

/** tool_result.content -> scannable text (plain string, or the text blocks joined). */
const codexResultText = c =>
  typeof c === "string" ? c
    : Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join("\n")
    : "";

const CODEX_ID_LINE  = /^[ \t]*session id: ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t\r]*$/;
const CODEX_FIELD    = /^[ \t]*[a-z][a-z ]{0,30}:[ \t]*\S.*$/;   // generic banner "key: value"
const CODEX_KEY      = /^[ \t]*([a-z][a-z ]{0,30}):/;            // its key, for the harvest
const CODEX_RULE     = /^[ \t]*-{4,}[ \t\r]*$/;                  // codex's own banner rule
const CODEX_VERSION  = /^[ \t]*OpenAI Codex v(\S+)[ \t\r]*$/;
const CODEX_TOK_HDR  = /^[ \t]*tokens used[ \t\r]*$/;
const CODEX_TOK_VAL  = /^[ \t]*([\d,]+)[ \t\r]*$/;
const CODEX_WALK_MAX = 32;                                       // upward-walk bound
const codexTrim = v => v.replace(/^[ \t\r]+/, "").replace(/[ \t\r]+$/, "");

/**
 * Strictly-better test for two sightings of one uuid in one file. Two keys, in
 * order: a banner-anchored record beats an unanchored one, then max tokens wins
 * (the rule "seen" already uses for duplicate messages). A tie on both keys keeps
 * the incumbent, i.e. the first sighting in file order -- so replaying the same
 * bytes from offset 0 reaches the same winner.
 */
const codexBetter = (a, b) =>
  a.anchored !== b.anchored
    ? a.anchored
    : (a.tokensUsed ?? -1) > (b.tokensUsed ?? -1);

/** Every "session id:" line in the text is a detection -- not just the first. */
function codexDetections(text, start, end) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CODEX_ID_LINE.exec(lines[i]);
    if (m) out.push(codexRecord(lines, i, m[1].toLowerCase(), start, end));
  }
  return out;
}

/**
 * Fields are harvested from the banner *block* around one session-id line, never
 * by a free regex over the whole text, and only when that block is anchored: the
 * run of "key: value" lines above the id must be closed by codex's own "-----"
 * rule line. Unanchored hits are grep output or log re-reads, where line adjacency
 * carries no printing-order semantics -- they get the id and nothing else (missing
 * over wrong). Node creation is NOT gated: an unanchored hit is still a detection.
 */
function codexRecord(lines, i, sessionId, start, end) {
  let j = i - 1;                                            // first non-field line above
  for (let n = 0; n < CODEX_WALK_MAX && j >= 0 && CODEX_FIELD.test(lines[j]); n++) j--;
  const anchored = j >= 0 && CODEX_RULE.test(lines[j]);
  const r = { sessionId, start, end, anchored, model: null, effort: null, workdir: null,
              sandbox: null, approval: null, codexVersion: null, tokensUsed: null };
  if (!anchored) return r;
  const field = new Map();                                  // nearest the id line wins
  for (let k = i - 1; k > j; k--) {
    const km = CODEX_KEY.exec(lines[k]);
    if (km && !field.has(km[1])) field.set(km[1], codexTrim(lines[k].slice(km[0].length)));
  }
  r.model    = field.get("model") ?? null;
  r.effort   = field.get("reasoning effort") ?? null;
  r.workdir  = field.get("workdir") ?? null;
  r.sandbox  = field.get("sandbox") ?? null;
  r.approval = field.get("approval") ?? null;
  const v = j > 0 ? CODEX_VERSION.exec(lines[j - 1]) : null;
  r.codexVersion = v ? v[1] : null;
  let stop = lines.length;                                  // window: up to the next id line
  for (let k = i + 1; k < lines.length; k++) if (CODEX_ID_LINE.test(lines[k])) { stop = k; break; }
  let raw = null;                                           // last adjacent "tokens used"/N pair
  for (let k = i + 1; k + 1 < stop; k++) {
    if (!CODEX_TOK_HDR.test(lines[k])) continue;
    const tv = CODEX_TOK_VAL.exec(lines[k + 1]);
    if (tv) raw = tv[1];
  }
  if (raw !== null) {
    const n = parseInt(raw.replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n > 0) r.tokensUsed = n;
  }
  return r;
}
