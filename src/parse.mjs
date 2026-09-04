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

// Text prefixes a human never typed: launcher-injected notes, the harness
// echoing its own stdout back, and a bare interruption marker. A closed list,
// deliberately not a generic "starts with <" test — a slash command reaches the
// transcript as <command-message>…</command-message> and a human did type it.
const NOT_HUMAN = ["<paseo-system", "<local-command-stdout", "[Request interrupted"];

/** Text of a tool_result block (whose content is a string or its own blocks). */
const resultText = b => (typeof b.content === "string" ? b.content
  : Array.isArray(b.content) ? b.content.filter(x => x.type === "text").map(x => x.text).join(" ")
  : "").trim();

export class SessionFileParser {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.tail = "";            // partial last line
    this.seen = new Map();     // message.id -> {tot, u, model, ts, uuid}
    this.chain = new Map();    // record uuid -> its own promptId, else its parentUuid
    this.promptTs = new Map(); // promptId -> earliest timestamp; also the set of known promptIds
    this.uses = [];            // {uuid, name, id, skill} per tool_use block and per skill marker
    this.pool = new Map();     // string interning: promptIds, tool names, skill names
    this.models = new Set();
    this.efforts = new Set();
    this.first = null; this.last = null;
    this.userMsgs = 0;
    this.humanTurns = new Set();       // promptIds credited to a human (see #line)
    this.asked = new Map();            // AskUserQuestion tool_use id -> {ts, questions, done}
    this.interactions = [];            // answered gates, question/answer pairs
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
      this.toolUseIds.clear(); this.humanTurns.clear(); this.identity = {};
      this.asked.clear(); this.interactions = [];
      this.firstPrompt = null; this.summary = null;
      this.skills = []; this.branches = new Set();
      this.cwd = null; this.version = null; this.repo = null;
      // Turn attribution is derived from chain/promptTs, never recomputed against
      // the file, so these must be reset with the rest: a survivor of the
      // *replaced* file walks parentUuid pointers a stale chain still answers, and
      // a stale promptTs still terminates that walk on a promptId the new file
      // never had. Measured by replacing a transcript with a compacted version of
      // itself: 162 calls attributed and 0 orphans, against a correct 161 and 1,
      // with the two turns arrays unequal. That is a wrong number, not untidiness,
      // and no acceptance check sees it. uses is the append-only one: missing its
      // reset re-appends the whole file, and the id-dedup in #turns() hides that
      // in every figure, so it surfaces as a serve process that grows rather than
      // as a check that fails. pool is only an intern table, cleared for symmetry.
      this.chain.clear(); this.promptTs.clear();
      this.uses.length = 0; this.pool.clear();
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
    // Append-only bookkeeping for turns; nothing is resolved here. update() reads
    // by byte offset, so a record can be parsed before its ancestors in the same
    // chunk — walking the chain now would depend on a chunk-local completeness
    // this parser deliberately does not have. The whole walk is deferred to
    // #turns(). Records with no message still carry uuid and parentUuid and are
    // links in that chain, so this runs before the return below.
    const pid = typeof o.promptId === "string" && o.promptId ? this.#intern(o.promptId) : null;
    if (pid) {
      const prev = this.promptTs.get(pid);
      if (prev === undefined || (o.timestamp && o.timestamp < prev))
        this.promptTs.set(pid, o.timestamp);
    }
    if (o.uuid) this.chain.set(o.uuid, pid || o.parentUuid || null);
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
      if (t0.startsWith("Base directory for this skill: ")) {
        const sk = t0.split("\n")[0].split("/").pop();
        this.#skill(sk);
        this.uses.push({ uuid: o.uuid, name: null, id: null, skill: sk ? this.#intern(sk) : null });
      }
      // A turn is one distinct promptId, and it is human if ANY of its records
      // looks typed by a person. Credit is only ever added, never retracted, so
      // the count is monotone under append and idempotent under re-feed — which
      // is what a byte-offset parser over a live, appending file requires.
      if (typeof o.promptId === "string" && o.promptId && !o.isMeta
          && o.origin?.kind !== "task-notification"
          && !NOT_HUMAN.some(p => t0.startsWith(p)))
        this.humanTurns.add(o.promptId);
    }
    // The answer to an AskUserQuestion gate arrives as a tool_result, which the
    // text predicate above excludes by construction — yet it is the least
    // ambiguous human input there is, so it credits its turn too.
    if (o.type === "user" && Array.isArray(c))
      for (const b of c) if (b.type === "tool_result" && this.asked.has(b.tool_use_id)) {
        this.#answer(b, o.timestamp);
        if (typeof o.promptId === "string" && o.promptId) this.humanTurns.add(o.promptId);
      }
    if (Array.isArray(c))
      for (const b of c) if (b.type === "tool_use") {
        this.toolUseIds.add(b.id);
        if (b.name === "AskUserQuestion") this.#ask(b, o.timestamp);
        const sk = b.name === "Skill" && b.input?.skill ? b.input.skill : null;
        if (sk) this.#skill(sk);
        this.uses.push({ uuid: o.uuid, name: b.name ? this.#intern(b.name) : null,
          id: b.id ?? null, skill: sk ? this.#intern(sk) : null });
      }
    if (m.usage && m.id && m.model !== SYNTHETIC) {
      const u0 = m.usage;
      const u = { in: u0.input_tokens || 0, out: u0.output_tokens || 0,
        cr: u0.cache_read_input_tokens || 0,
        c5:  (u0.cache_creation || {}).ephemeral_5m_input_tokens || 0,
        c1h: (u0.cache_creation || {}).ephemeral_1h_input_tokens || 0 };
      const tot = u.in + u.out + u.cr + u.c5 + u.c1h;
      const prev = this.seen.get(m.id);
      // uuid rides along on the winning variant: it is the only link from a
      // deduped API call back to its record, and therefore back to its turn.
      if (!prev || tot > prev.tot)
        this.seen.set(m.id, { tot, u, model: m.model, ts: o.timestamp, uuid: o.uuid });
    }
  }

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
    this.interactions.push({
      id: b.tool_use_id, ts: a.ts || ts, answeredAt: ts, questions: a.questions,
      answers: [...raw.matchAll(/"[^"]*"="([^"]*)"/g)].map(m => m[1]),
      answerText: raw.slice(0, 500),
    });
  }

  #skill(name) { if (name && !this.skills.includes(name)) this.skills.push(name); }

  /**
   * One shared string instance per distinct promptId, tool name and skill name.
   * Not only a byte count: the skill name is cut out of the marker message with
   * split(), so V8 hands back a slice that pins the whole message — 31 KB of skill
   * body per marker — alive for as long as the parser lives. Measured over 1753
   * transcripts, interning the 1102 marker names drops retained heap from 78.3 MB
   * to 43.4 MB, because the surviving instance is the one this.skills already held.
   */
  #intern(s) { const p = this.pool.get(s); if (p !== undefined) return p; this.pool.set(s, s); return s; }

  /**
   * Regroup this file's API calls into the turns that produced them, and index
   * every tool_use id by the turn it happened in (the provider joins subagents on
   * that index; it goes nowhere else).
   */
  #turns() {
    // Resolution happens here and only here — see the note in #line(). Walking
    // upwards at aggregate time means every ancestor a record will ever have has
    // already been appended, so re-parsing any byte range converges to the same
    // turn numbers. Nothing is written back over a walked path: at 3.1 hops on
    // average and 7 at worst over the reference session, memoising buys nothing
    // and introduces the one way this can go wrong — caching the failure of a
    // walk whose ancestor has simply not arrived yet, which strands that record
    // permanently instead of letting it resolve on the next pass.
    const turnOf = (uuid) => {
      let cur = uuid;
      // A parentUuid chain is acyclic in an append-only transcript; the bound is
      // a liveness guard so a corrupt file cannot spin a long-lived serve process.
      for (let hops = this.chain.size; cur != null && hops-- > 0; ) {
        const v = this.chain.get(cur);
        if (v == null) return null;
        if (this.promptTs.has(v)) return v;
        cur = v;
      }
      return null;
    };

    // Dedup first, then group — the order is not interchangeable. this.seen is
    // already keyed by message.id with the MAX-usage variant kept (see #line), so
    // iterating it here means every streaming duplicate has collapsed before a
    // single turn is counted. Grouping the raw records and deduping afterwards
    // would inflate every per-turn figure by more than 2x (553 usage-bearing
    // records against 251 survivors on the reference session) — loudly on a
    // finished session, and silently on a live one where the duplicates are still
    // in flight and the numbers only look plausible.
    const byTurn = new Map();
    for (const [, v] of this.seen) {
      const pid = v.uuid == null ? null : turnOf(v.uuid);
      if (pid == null) continue;   // orphan: still counted in apiCalls, in no turn
      let g = byTurn.get(pid);
      if (!g) byTurn.set(pid, g = { pid, calls: 0, usd: 0, cp: ZERO_PARTS(),
        t: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        start: null, end: null, skills: [], tools: new Map(), ids: new Set() });
      g.calls++;
      g.t.input += v.u.in; g.t.output += v.u.out; g.t.cacheRead += v.u.cr;
      g.t.cacheWrite5m += v.u.c5; g.t.cacheWrite1h += v.u.c1h;
      const r = priceClaude(v.model, v.ts, v.u);
      g.usd += r.usd;
      for (const k in g.cp) g.cp[k] += r.parts[k];
      if (v.ts) {
        if (g.start === null || v.ts < g.start) g.start = v.ts;
        if (g.end === null || v.ts > g.end) g.end = v.ts;
      }
    }

    // Skills and tools attach to the turn their record resolves to. A tool_use id
    // already counted within this turn is skipped: unlike apiCalls and cost, uses
    // is a plain append log and inherits nothing from the message.id dedup above.
    const idTurn = new Map();     // tool_use id -> promptId
    for (const e of this.uses) {
      const pid = e.uuid == null ? null : turnOf(e.uuid);
      if (pid == null) continue;
      const g = byTurn.get(pid);
      if (!g) continue;           // a promptId with no surviving call is not a turn
      if (e.id != null) {
        if (!idTurn.has(e.id)) idTurn.set(e.id, pid);
        if (g.ids.has(e.id)) continue;
        g.ids.add(e.id);
      }
      if (e.name) g.tools.set(e.name, (g.tools.get(e.name) || 0) + 1);
      if (e.skill && !g.skills.includes(e.skill)) g.skills.push(e.skill);
    }

    // Ordered by when the turn opened, never by insertion order: a live session
    // must not renumber the turns a reader is already looking at as records land.
    const list = [...byTurn.values()];
    list.sort((a, b) => {
      const ka = this.promptTs.get(a.pid) ?? a.start, kb = this.promptTs.get(b.pid) ?? b.start;
      if (ka !== kb) return (ka ?? "") < (kb ?? "") ? -1 : 1;
      return a.pid < b.pid ? -1 : 1;
    });

    const ordOf = new Map();
    const turns = list.map((g, i) => {
      ordOf.set(g.pid, i + 1);
      return {
        ordinal: i + 1,
        start: this.promptTs.get(g.pid) ?? g.start,
        end: g.end,
        apiCalls: g.calls,
        cost: +g.usd.toFixed(8),
        tokens: g.t,
        costParts: g.cp,
        skills: g.skills,
        subagents: [],            // filled by the provider: only it can see child nodes
        tools: Object.fromEntries(g.tools),
      };
    });

    const turnByToolUse = new Map();
    for (const [id, pid] of idTurn) turnByToolUse.set(id, ordOf.get(pid));
    return { turns, turnByToolUse };
  }

  aggregates() {
    const { turns, turnByToolUse } = this.#turns();
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
      humanMsgs: this.humanTurns.size,
      decisions: this.interactions.length, interactions: this.interactions,
      firstPrompt: this.firstPrompt, summary: this.summary,
      skills: [...this.skills], branch: [...this.branches][0] || null,
      cwd: this.cwd, version: this.version, repo: this.repo,
      tokens: t, costOwn: usd, costParts: cp,
      costConfidence: unknown.size ? "partial" : confidence,
      unknownModels: [...unknown], identity: this.identity,
      turns, turnByToolUse,
    };
  }
}
