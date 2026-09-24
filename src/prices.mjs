// Price tables per provider, $/MTok: [input, output, cacheRead, cacheWrite5m, cacheWrite1h].
// "confidence" of a computed cost:
//   verified  – multipliers validated to 8 decimals against the harness's own
//               total_cost_usd (haiku-4-5 and opus-5, 2026-09-01)
//   computed  – list price × tokens, multipliers assumed equal to verified models
//   n/a       – provider reports no usage
const CLAUDE = {
  "claude-opus-5":            { p: [5, 25, 0.50, 6.25, 10],   confidence: "verified" },
  "claude-fable-5":           { p: [10, 50, 1.00, 12.50, 20], confidence: "computed" },
  "claude-sonnet-5":          { p: [3, 15, 0.30, 3.75, 6],    confidence: "computed" },
  "claude-haiku-4-5-20251001":{ p: [1, 5, 0.10, 1.25, 2],     confidence: "verified" },
  "claude-haiku-4-5":         { p: [1, 5, 0.10, 1.25, 2],     confidence: "verified" },
};
// Sonnet 5 introductory pricing window (through 2026-08-31).
const SONNET_INTRO = [2, 10, 0.20, 2.50, 4];

// usage: {in, out, cr, c5, c1h}  ts: ISO timestamp of the message
// "parts" splits the same cost per token class (cache write folds 5m and 1h
// together, as every view does); their sum equals usd up to float rounding.
export const ZERO_PARTS = () => ({ in: 0, out: 0, cr: 0, cw: 0 });
export function priceClaude(model, ts, u) {
  const row = CLAUDE[model];
  if (!row) return { usd: 0, parts: ZERO_PARTS(), confidence: "n/a", unknownModel: model };
  let p = row.p;
  if (model === "claude-sonnet-5" && ts && ts < "2026-09-01") p = SONNET_INTRO;
  const usd = (u.in * p[0] + u.out * p[1] + u.cr * p[2] + u.c5 * p[3] + u.c1h * p[4]) / 1e6;
  const parts = { in: u.in * p[0] / 1e6, out: u.out * p[1] / 1e6, cr: u.cr * p[2] / 1e6,
                  cw: (u.c5 * p[3] + u.c1h * p[4]) / 1e6 };
  return { usd, parts, confidence: row.confidence };
}

// ---------------------------------------------------------------------------
// Codex (OpenAI) list prices, $/MTok, same 5-slot shape and same units.
//
// Retrieved 2026-09-06 from:
//   - https://developers.openai.com/api/docs/pricing        (gpt-6-astra, gpt-5.5)
//   - the gpt-5.6-sol model page on the same site           (gpt-5.6-sol)
//   - corroborated against OpenRouter's `openai/gpt-6-astra` listing
//
// All three rows are "computed", never "verified": Codex exposes no
// total_cost_usd anywhere in its store to validate a multiplier against, which
// is exactly what "verified" means above.
//
// gpt-5.6-sol's rate is PROMOTIONAL through ~2026-11-21 and no post-window rate
// is published. That is why there is no SONNET_INTRO-style window branch here:
// the machinery above works because both ends of the window and both rates are
// known; here the far side would be a guess, and a guessed price is the
// fabrication this file exists to avoid. Revisit when OpenAI publishes one.
//
// Cache-write slots are 1.25x uncached input, the better-corroborated of the
// published readings, and both tiers are priced identically because Codex
// reports one undifferentiated cache_write_input_tokens with no 5m/1h
// distinction -- so the tier the provider maps it into cannot change a figure.
// Currently unexercised either way: cache_write_input_tokens is 0 on every
// token_usage_record on this host.
//
// Deliberately not modelled: OpenAI's long-context (>=272K input) multiplier,
// the `fast` service tier, and Batch/Flex discounts. A flat row does not carry
// them, no sampled request exceeds 272K input tokens, and per-effort rows are
// already deferred by the spec.
const CODEX = {
  "gpt-6-astra": { p: [10, 50, 1.00, 12.50, 12.50], confidence: "computed" },
  "gpt-5.6-sol": { p: [ 4, 20, 0.40,  5.00,  5.00], confidence: "computed" },
  "gpt-5.5":     { p: [ 5, 30, 0.50,  6.25,  6.25], confidence: "computed" },
};

// Sibling of priceClaude, same signature, same return shape, same unknown-model
// fallback. `ts` is accepted and unused: it is precisely the parameter a
// promotional-window check would need (priceClaude uses it for exactly that),
// and keeping the signatures identical is what lets one caller shape serve both.
export function priceCodex(model, ts, u) {
  const row = CODEX[model];
  if (!row) return { usd: 0, parts: ZERO_PARTS(), confidence: "n/a", unknownModel: model };
  const p = row.p;
  const usd = (u.in * p[0] + u.out * p[1] + u.cr * p[2] + u.c5 * p[3] + u.c1h * p[4]) / 1e6;
  const parts = { in: u.in * p[0] / 1e6, out: u.out * p[1] / 1e6, cr: u.cr * p[2] / 1e6,
                  cw: (u.c5 * p[3] + u.c1h * p[4]) / 1e6 };
  return { usd, parts, confidence: row.confidence };
}
