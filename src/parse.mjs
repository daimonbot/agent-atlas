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
    this.identity = {};                // agent-name / custom-title / agent-setting
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
    }
    if (Array.isArray(c))
      for (const b of c) if (b.type === "tool_use") this.toolUseIds.add(b.id);
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
      tokens: t, costOwn: usd, costConfidence: unknown.size ? "partial" : confidence,
      unknownModels: [...unknown], identity: this.identity,
    };
  }
}
