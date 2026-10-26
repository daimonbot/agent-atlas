// Presentation only: retain raw model identifiers for matching and pricing.
// Codex documents this hidden model as its automatic approval reviewer:
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
export function modelLabel(model) {
  if (!model) return "model not recorded";
  return model === "codex-auto-review" ? "Codex Auto Review (internal)" : model;
}

export function modelTooltip(model, source) {
  if (!model) return "No execution model was recorded in the transcript or session metadata.";
  const description = model === "codex-auto-review"
    ? "Automatic permission checks performed by Codex (Guardian). Model id: codex-auto-review. Pricing requires a catalogue rate or local override."
    : "Model: " + model + ".";
  return description + (["thread_metadata", "thread_settings"].includes(source)
    ? " Declared in session metadata; no per-call model was recorded."
    : "");
}
