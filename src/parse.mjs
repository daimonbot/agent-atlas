// Incremental parser for one Claude Code transcript file (JSONL, append-only).
// Safe under live sessions: reads from a byte offset, keeps partial trailing
// lines for the next pass, and aggregation is idempotent (dedup by message.id
// keeping the MAX-usage variant, which is how the harness resolves its own
// streaming duplicates). Re-parsing any range converges to the same numbers.
import fs from "node:fs";
import { priceClaude, ZERO_PARTS } from "./prices.mjs";

// The harness stamps locally-generated messages ("No response requested.",
// interrupts) with this pseudo-model and an all-zero usage block. It is not a
// provider: counting it would list a model nobody ran and, because it has no
// price row, would downgrade the whole session's cost to "partial".
const SYNTHETIC = "<synthetic>";

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
    this.cwd = null;                   // working directory (every record carries it)
    this.version = null;               // Claude Code version that wrote the transcript
    this.repo = null;                  // {repo, prNumber, prUrl} — only if a PR was opened
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
      this.cwd = null; this.version = null; this.repo = null;
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
    if (o.cwd && !this.cwd) this.cwd = o.cwd;
    if (o.version) this.version = o.version;
    // the only place a remote ever appears: the harness logs the PR it opened
    if (o.type === "pr-link" && o.prRepository && !this.repo)
      this.repo = { repo: o.prRepository, prNumber: o.prNumber, prUrl: o.prUrl };
    if (o.type === "agent-name")   this.identity.agentName   = o.agentName;
    if (o.type === "custom-title") this.identity.customTitle = o.customTitle;
    if (o.type === "agent-setting")this.identity.agentSetting= o.agentSetting;
    const m = o.message; if (!m) return;
    if (m.model && m.model !== SYNTHETIC) this.models.add(m.model);
    const c = m.content;
    if (o.type === "user" && (typeof c === "string" ||
        (Array.isArray(c) && c.some(b => b.type === "text") && !c.some(b => b.type === "tool_result")))) {
      this.userMsgs++;
      if (!this.firstPrompt) {
        const txt = (typeof c === "string" ? c
          : c.filter(b => b.type === "text").map(b => b.text).join(" ")).trim();
        if (txt && !txt.startsWith("<") && !txt.startsWith("Base directory for this skill")
            && !txt.startsWith("[Request interrupted"))
          this.firstPrompt = txt.replace(/\s+/g, " ").slice(0, 2000);
      }
      const t0 = (typeof c === "string" ? c : c.filter(b => b.type === "text").map(b => b.text).join(" ")).trim();
      if (t0.startsWith("Base directory for this skill: "))
        this.#skill(t0.split("\n")[0].split("/").pop());
    }
    if (Array.isArray(c))
      for (const b of c) if (b.type === "tool_use") {
        this.toolUseIds.add(b.id);
        if (b.name === "Skill" && b.input?.skill) this.#skill(b.input.skill);
      }
    if (m.usage && m.id && m.model !== SYNTHETIC) {
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

  aggregates() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const byModel = new Map();      // ranks the model list: busiest first
    let usd = 0; const cp = ZERO_PARTS();
    let confidence = "verified"; const unknown = new Set();
    for (const [, v] of this.seen) {
      t.input += v.u.in; t.output += v.u.out; t.cacheRead += v.u.cr;
      t.cacheWrite5m += v.u.c5; t.cacheWrite1h += v.u.c1h;
      byModel.set(v.model, (byModel.get(v.model) || 0) + v.tot);
      const r = priceClaude(v.model, v.ts, v.u);
      usd += r.usd;
      for (const k in cp) cp[k] += r.parts[k];
      if (r.unknownModel) unknown.add(r.unknownModel);
      if (r.confidence === "computed" && confidence === "verified") confidence = "computed";
    }
    return {
      model: [...this.models].sort((a, b) => (byModel.get(b) || 0) - (byModel.get(a) || 0)),
      effort: [...this.efforts],
      start: this.first, end: this.last,
      durationS: this.first && this.last ? Math.round((new Date(this.last) - new Date(this.first)) / 1000) : null,
      apiCalls: this.seen.size, userMsgs: this.userMsgs,
      firstPrompt: this.firstPrompt, summary: this.summary,
      skills: [...this.skills], branch: [...this.branches][0] || null,
      cwd: this.cwd, version: this.version, repo: this.repo,
      tokens: t, costOwn: usd, costParts: cp,
      costConfidence: unknown.size ? "partial" : confidence,
      unknownModels: [...unknown], identity: this.identity,
    };
  }
}
