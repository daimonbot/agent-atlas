// Public, maintained price catalogues. Each source turns its payload into the
// same shape: Map<canonical model, {key, p}> with p = $/MTok
// {in, out, cr, cw5, cw1h}; a class the source does not publish is null.
import { exactId, isDirect } from "./match.mjs";

const MTOK = 1e6;
const per = v => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? +(v * MTOK).toPrecision(10) : null);
const perStr = v => (v == null || v === "" ? null : per(Number(v)));

function keep(map, key, p) {
  if (p.in == null || p.out == null) return;
  const canon = exactId(key);
  if (!canon) return;
  const prev = map.get(canon);
  // Prefer the direct (unprefixed) record; otherwise first seen wins.
  if (prev && (isDirect(prev.key) || !isDirect(key))) return;
  map.set(canon, { key, p });
}

export const SOURCES = {
  litellm: {
    // Primary: broadest coverage, bare provider keys, cache-read/write/1h-write.
    url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    parse(json) {
      const map = new Map();
      for (const [key, e] of Object.entries(json || {})) {
        if (!e || typeof e !== "object" || key === "sample_spec") continue;
        if (e.mode && e.mode !== "chat" && e.mode !== "responses") continue;
        keep(map, key, { in: per(e.input_cost_per_token), out: per(e.output_cost_per_token),
          cr: per(e.cache_read_input_token_cost), cw5: per(e.cache_creation_input_token_cost),
          cw1h: per(e.cache_creation_input_token_cost_above_1hr) });
      }
      return map;
    },
  },
  openrouter: {
    // Secondary: independent catalogue, used only for models LiteLLM lacks (lag).
    url: "https://openrouter.ai/api/v1/models",
    parse(json) {
      const map = new Map();
      for (const m of json?.data || []) {
        const pr = m?.pricing; if (!pr || typeof m.id !== "string" || m.id.includes(":")) continue;
        keep(map, m.id, { in: perStr(pr.prompt), out: perStr(pr.completion),
          cr: perStr(pr.input_cache_read), cw5: perStr(pr.input_cache_write), cw1h: perStr(pr.input_cache_write_1h) });
      }
      return map;
    },
  },
};
// Lookup order. Earlier wins when both know a model.
export const SOURCE_ORDER = ["litellm", "openrouter"];
// A payload that parses to fewer priced models than this is a broken or
// redesigned source, never a price list.
export const MIN_MODELS = 50;
