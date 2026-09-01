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
