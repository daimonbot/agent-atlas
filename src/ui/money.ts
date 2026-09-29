// Every dollar figure the UI shows goes through here, so that "unknown" can never
// be rendered as "$0.00". A cost's confidence decides its text:
//   "n/a"      nothing in it was priced (no price for the model) -> "n/a"
//   "partial"  some of it was not priced, so the figure is a lower bound -> "≥ $x"
//   anything else                                                     -> "$x"
export const money = (value?: number | null) => value == null ? "—" : value > 0 && value < .01 ? "$" + value.toFixed(4) : "$" + value.toFixed(2);

export const costText = (value: number | null | undefined, confidence?: string) =>
  confidence === "n/a" ? "n/a" : (confidence === "partial" ? "≥ " : "") + money(value);

type Priced = { cost?: { total?: number; own?: number; confidence?: string; ownConfidence?: string } };
/** The combined confidence of several costs: n/a only if none is known. */
export const combined = (confidences: (string | undefined)[]) =>
  confidences.length && confidences.every(c => c === "n/a") ? "n/a" : confidences.some(c => c === "n/a" || c === "partial") ? "partial" : undefined;

export const totalText = (node: Priced) => costText(node.cost?.total, node.cost?.confidence);
export const ownText = (node: Priced) => costText(node.cost?.own, node.cost?.ownConfidence ?? node.cost?.confidence);
/** The summed subtree totals of `nodes`. */
export const sumText = (nodes: Priced[], value = nodes.reduce((sum, node) => sum + (node.cost?.total || 0), 0)) =>
  costText(value, combined(nodes.map(node => node.cost?.confidence)));

/** Hover text naming what could not be priced. */
export const unpricedTitle = (confidence?: string, models?: string[]) =>
  confidence === "n/a" || confidence === "partial" ? "No price available for: " + ((models || []).join(", ") || "part of the usage") : undefined;
