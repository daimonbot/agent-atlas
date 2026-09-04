// Incremental parser for one Claude Code transcript file (JSONL, append-only).
// Safe under live sessions: reads from a byte offset, keeps partial trailing
// lines for the next pass, and aggregation is idempotent (dedup by message.id
// keeping the MAX-usage variant, which is how the harness resolves its own
// streaming duplicates). Re-parsing any range converges to the same numbers.
import fs from "node:fs";
import { priceClaude } from "./prices.mjs";

/** Concatenated text blocks of a message content (string or block array). */
const textOf = c => (typeof c === "string" ? c
  : Array.isArray(c) ? c.filter(b => b.type === "text").map(b => b.text).join(" ")
  : "").trim();

/** Machinery that the harness writes as a `type:"user"` line, by prefix. */
const INJECTED = [
  "<",                                    // <system-reminder>, <task-notification>, …
  "Base directory for this skill",        // skill preamble
  "[Request interrupted",                 // the human stopped a tool; typed nothing
  "[Your previous response had no visible output",   // harness nudge
  "This session is being continued from",            // compaction preamble
];

/**
 * Did a person type this? One predicate for the counter and for firstPrompt —
 * two diverging ones is how the count went wrong: the counter took every line
 * of the list above for human input.
 */
const isHuman = t => !!t && !INJECTED.some(p => t.startsWith(p));

/** Text of a tool_result block (whose content is a string or its own blocks). */
const resultText = b => (typeof b.content === "string" ? b.content
  : Array.isArray(b.content) ? b.content.filter(x => x.type === "text").map(x => x.text).join(" ")
  : "").trim();

export class SessionFileParser {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.tail = "";            // partial last line
    this.seen = new Map();     // message.id -> {tot, u, model, ts}
    this.models = new Set();
    this.efforts = new Set();
    this.first = null; this.last = null;
    this.prompts = 0;                  // messages a human actually typed
    this.decisions = 0;                // AskUserQuestion gates the human answered
    this.asked = new Map();            // AskUserQuestion tool_use id -> {ts, questions, done}
    this.interactions = [];            // answered gates, question/answer pairs
    this.toolUseIds = new Set();       // tool_use ids seen (spawn attachment)
    this.firstPrompt = null;           // first real user prompt (session description)
    this.summary = null;               // harness-written summary record, if any
    this.skills = [];                  // skills invoked, in first-seen order
    this.branches = new Set();         // git branches seen (minus HEAD)
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
      this.first = this.last = null; this.prompts = 0; this.decisions = 0;
      this.asked.clear(); this.interactions = [];
      this.toolUseIds.clear(); this.identity = {};
      this.firstPrompt = null; this.summary = null;
      this.skills = []; this.branches = new Set();
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
    if (o.type === "user" && c != null) {
      const t0 = textOf(c);
      if (isHuman(t0)) {
        this.prompts++;
        if (!this.firstPrompt) this.firstPrompt = t0.replace(/\s+/g, " ").slice(0, 500);
      }
      if (t0.startsWith("Base directory for this skill: "))
        this.#skill(t0.split("\n")[0].split("/").pop());
      // The other half of human input: the answer to an AskUserQuestion gate.
      // It arrives as a tool_result, so it is never a prompt — and is exactly
      // the point where an autonomous run stopped and waited for a person.
      if (Array.isArray(c))
        for (const b of c) if (b.type === "tool_result" && this.asked.has(b.tool_use_id))
          this.#answer(b, o.timestamp);
    }
    if (Array.isArray(c))
      for (const b of c) if (b.type === "tool_use") {
        this.toolUseIds.add(b.id);
        if (b.name === "Skill" && b.input?.skill) this.#skill(b.input.skill);
        if (b.name === "AskUserQuestion") this.#ask(b, o.timestamp);
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

  /** Remember a gate's questions; its answer arrives later, matched by id. */
  #ask(b, ts) {
    if (this.asked.has(b.id)) return;         // a re-emitted line is the same gate
    this.asked.set(b.id, { ts, questions: (b.input?.questions || []).map(q => ({
      header: q.header ?? null,
      question: String(q.question ?? "").replace(/\s+/g, " ").slice(0, 500),
      multiSelect: !!q.multiSelect,
      options: (q.options || []).map(o => o.label).filter(Boolean) })) });
  }

  /**
   * Record an answered gate. The harness writes the answers back as prose
   * ("question"="answer", one per question), so the parse is best-effort and
   * the raw text is kept alongside it: a gate is never lost to a bad parse.
   */
  #answer(b, ts) {
    const a = this.asked.get(b.tool_use_id);
    if (a.done) return;                       // an id is answered exactly once
    a.done = true;
    const raw = resultText(b).replace(/\s+/g, " ");
    this.decisions++;
    this.interactions.push({
      id: b.tool_use_id, ts: a.ts || ts, answeredAt: ts, questions: a.questions,
      answers: [...raw.matchAll(/"[^"]*"="([^"]*)"/g)].map(m => m[1]),
      answerText: raw.slice(0, 500),
    });
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
      apiCalls: this.seen.size,
      prompts: this.prompts, decisions: this.decisions, interactions: this.interactions,
      firstPrompt: this.firstPrompt, summary: this.summary,
      skills: [...this.skills], branch: [...this.branches][0] || null,
      tokens: t, costOwn: usd, costConfidence: unknown.size ? "partial" : confidence,
      unknownModels: [...unknown], identity: this.identity,
    };
  }
}
