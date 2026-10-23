// Model-name matching across harness naming. One canonical form per model, so
// that "claude-opus-5-5", "anthropic/claude-opus-5.5", "us.anthropic.claude-opus-5-5-v1:0",
// "claude-opus-5-5-20260921" and "claude-opus-5-5[1m]" all meet in the same slot.
//
// Deliberately NOT done: prefix or fuzzy guessing ("claude-opus-5-6" does not
// fall back to "claude-opus-5"). A guessed price is the silent wrong number this
// subsystem exists to remove; an unmatched model is reported as unknown.

const PROVIDER_PREFIX = /^(?:(?:global|us|eu|apac|au|jp|us-gov)\.)?(?:anthropic|openai)\.|^(?:openrouter|anthropic|openai|azure|azure_ai|vertex_ai|bedrock|bedrock_mantle|github_copilot|chatgpt|databricks|perplexity|aihubmix|deepinfra)\//;

export function canonical(raw) {
  if (typeof raw !== "string") return null;
  let m = raw.trim().toLowerCase();
  if (!m) return null;
  m = m.replace(/\[[^\]]*\]$/, "");                         // context-window tag: "[1m]"
  for (let i = 0; i < 4; i++) {                              // "azure/us/gpt-..", "bedrock/us-gov-west-1/anthropic.claude-.."
    const next = m.replace(PROVIDER_PREFIX, "").replace(/^(?:us|eu|apac|global|us-gov-west-1|us-gov-east-1)\//, "");
    if (next === m) break; m = next;
  }
  m = m.replace(/@.*$/, "")                                  // vertex: "claude-opus-5@20260921", "@default"
       .replace(/-v\d+:\d+$/, "")                            // bedrock: "-v1:0"
       .replace(/:[a-z0-9-]+$/, "")                          // openrouter ":batch" style suffixes
       .replace(/-(?:19|20)\d{2}-?\d{2}-?\d{2}$/, "")        // date suffix, dashed or not
       .replace(/\./g, "-");                                 // "opus-5.5" == "opus-5-5"
  return m || null;
}

// A catalogue key is "direct" when it names the model with no routing prefix, so
// among several keys with one canonical form the direct one is the better record.
export const isDirect = key => canonical(key) !== null && !PROVIDER_PREFIX.test(key.toLowerCase()) && !/[\/@]/.test(key);
