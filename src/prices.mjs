// Thin harness-facing facade over the pricing subsystem (src/pricing/). Prices
// are no longer tables in the source: they come from a runtime catalogue, with
// provenance and an explicit unknown state. See README "Pricing".
//
// usage: {in, out, cr, c5, c1h} tokens. `ts` is accepted for signature stability
// and unused: catalogues publish the current price only, so a historical session
// is priced at today's list price (provenance carries the fetch time).
import { priceUsage, ZERO_PARTS } from "./pricing/index.mjs";
export { ZERO_PARTS };
export const priceClaude = (model, ts, u) => priceUsage(model, u);
export const priceCodex = (model, ts, u) => priceUsage(model, u);
