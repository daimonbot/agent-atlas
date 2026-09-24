// The tree-node shape, authored in exactly one place.
//
// Every provider reaches the node object through finish(); none builds a node
// literal of its own. That is what makes "the same top-level key set for both
// providers" a structural property rather than two implementations happening to
// agree — this repo has no tests, and the last three commits each *added* keys
// to this shape.
//
// Moved verbatim out of providers/claude.mjs, where it was a closure inside
// buildTree(); every input it reads was already a parameter. The only thing
// parameterized on the way out is the provider name, which used to be read from
// claude.mjs's module-level `name` and is now always `extra.provider` -- the
// key the codex leaf and the codex provider already set, so neither of those
// call sites had to move.
import { ZERO_PARTS } from "../prices.mjs";

/**
 * One tree node.
 *
 * st       an aggregates()-shaped object (parse.mjs:387-420) or a provider's
 *          synthetic equivalent; null for a node whose file does not exist.
 * extra    overlays: `provider` (required -- the node's own provider name),
 *          plus the optional phase, round and reported.
 * tuid     Map<agentId, toolUseId> for joining children back to their turn.
 */
export function finish(agent, description, agentId, via, st, children, extra, tuid) {
  children.sort((a, b) => ((a.start || "") < (b.start || "") ? -1 : 1));
  // Turns arrive from the parser with an empty subagents array, because only
  // here are both the turn index and the child nodes in hand. A node built for
  // a file that does not exist has no st at all, hence the guarded read.
  const turns = (st && st.turns) || [];
  // A turn is only ever "human" on the root transcript: a subagent's opening
  // prompt is the parent's errand, and the parser cannot tell the difference
  // from inside the file.
  if (via !== "root") for (const t of turns) { t.human = false; t.decisions = 0; }
  const callList = (st && st.calls) || [];
  if (via !== "root") for (const k of callList) { k.opensHuman = false; k.gates = 0; }
  // A harness child records the tool_use that spawned it on its sidecar, so it
  // joins exactly. A CLI child is launched by an outside process and records
  // nothing, so it falls back to the last turn that had already opened when the
  // child started, and says so with "inferred". The fallback is a prefix, not
  // clock containment: a turn closes at its last API call and an external
  // launch routinely happens after that, which is why containment matched 0 of
  // the corpus's 2 real CLI children. st.turnByToolUse is consumed here and
  // never copied onto the node.
  const byTU = (st && st.turnByToolUse) || null;
  for (const c of children) {
    const id = tuid && c.agentId != null ? tuid.get(c.agentId) : undefined;
    let t = null, match = "exact";
    if (id != null && byTU && byTU.has(id)) t = turns[byTU.get(id) - 1] || null;
    if (!t && c.start) {
      match = "inferred";
      for (const cand of turns)
        if (cand.start <= c.start && (!t || cand.ordinal > t.ordinal)) t = cand;
    }
    if (t) t.subagents.push({ agentId: c.agentId, agent: c.agent, start: c.start, match });
  }
  const childUsd = children.reduce((a, c) => a + c.cost.total, 0);
  const own = st ? st.costOwn : 0;
  let conf = st ? st.costConfidence : "n/a";
  // A displayed subtree is incomplete if any descendant is incomplete, even
  // when this node's own token records were fully priced.
  if (children.some(c => c.cost.confidence === "partial" || c.cost.confidence === "n/a"))
    conf = conf === "n/a" ? "n/a" : "partial";
  // Human effort belongs to the session a person typed into: a subagent's
  // "user message" is its parent's errand, so only a root node keeps the
  // parser's count. This is the single place root-ness is enforced, and the
  // `via` conjunct is what does the work: a leaf built from an outside
  // provider's data passes a truthy synthetic `st` with no humanMsgs key.
  const hm = via === "root" && st ? (st.humanMsgs || 0) : 0;
  const calls = st ? st.apiCalls : 0;
  // total is the rolled-up cost already shown everywhere; calls stay root-only.
  const total = +(own + childUsd).toFixed(4);
  return {
    agent, description, agentId, provider: extra.provider, via,
    ...(st ? { model: st.model, effort: st.effort, start: st.start, end: st.end,
               durationS: st.durationS, apiCalls: st.apiCalls, userMsgs: st.userMsgs,
               tokens: st.tokens, costParts: st.costParts,
               identity: st.identity, unknownModels: st.unknownModels,
               firstPrompt: st.firstPrompt, summary: st.summary,
               skills: st.skills, branch: st.branch,
               cwd: st.cwd, version: st.version, repo: st.repo }
           : { model: [], effort: [], start: null, end: null, durationS: null,
               apiCalls: 0, userMsgs: 0,
               tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
               costParts: ZERO_PARTS(),
               identity: {}, unknownModels: [], skills: [], branch: null,
               cwd: null, version: null, repo: null }),
    humanMsgs: hm,
    decisions: via === "root" && st ? (st.decisions || 0) : 0,
    interactions: via === "root" && st ? (st.interactions || []) : [],
    costPerHumanMsg: hm ? +(total / hm).toFixed(4) : null,
    callsPerHumanMsg: hm ? +(calls / hm).toFixed(4) : null,
    ...("phase" in extra && extra.phase !== undefined ? { phase: extra.phase } : {}),
    ...("round" in extra && extra.round !== undefined ? { round: extra.round } : {}),
    ...(extra.missingTranscript ? { missingTranscript: true } : {}),
    ...(extra.reported ? { reported: extra.reported } : {}),
    cost: { own: +own.toFixed(4), children: +childUsd.toFixed(4),
            total, confidence: conf },
    turns,
    calls: callList,
    children,
  };
}
