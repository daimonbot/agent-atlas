// The provider registry: the one place that knows which providers exist.
//
// cli.mjs and server.mjs go through this and name no provider anywhere. A ref
// carries its own `provider`, which is the only dispatch key buildTree needs.
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";

// Order is not part of the contract -- both consumers sort by mtimeMs
// immediately -- but it is fixed anyway so refFromPath is deterministic and so
// Claude rows stay first among equal-mtimeMs refs (no visible reordering on a
// host with no Codex data).
const PROVIDERS = [codex, claude];
const byName = new Map(PROVIDERS.map(p => [p.name, p]));

/** Every top-level session ref, from every provider. */
export function discover() {
  const out = [];
  for (const p of PROVIDERS) {
    // Fault-isolated per provider: one provider's store being unreadable must
    // never suppress the other's sessions.
    try { out.push(...p.discover()); }
    catch (e) { console.error(`agent-atlas: ${p.name}: discover failed: ${e.message}`); }
  }
  return out;
}

/**
 * The tree for one ref. Throws on an unknown provider, and lets the provider's
 * own failures through: the single-session callers fail loudly, and the two bulk
 * scan loops isolate per ref themselves -- that is where a dropped session can
 * be dropped without hollowing out the one a user asked for.
 */
export function buildTree(ref, cache) {
  const p = ref && byName.get(ref.provider);
  if (!p) throw new Error(`unknown provider '${ref && ref.provider}'`);
  const tree = p.buildTree(ref, cache);
  if (ref.provider === "claude") hydrateCodex(tree, cache);
  return tree;
}

function hydrateCodex(node, cache) {
  for (const child of node.children) {
    hydrateCodex(child, cache);
    if (child.provider !== "codex" || child.via !== "cli") continue;
    try {
      const real = codex.buildTree({ provider: "codex", id: child.agentId }, cache);
      const reported = child.reported;
      Object.assign(child, real, { via: "cli", description: child.description, reported });
      child.humanMsgs = 0; child.decisions = 0; child.interactions = [];
    } catch { /* The transcript reference outlived the local Codex store. */ }
  }
  const own = node.cost.own;
  const children = node.children.reduce((sum, child) => sum + child.cost.total, 0);
  node.cost.children = +children.toFixed(4);
  node.cost.total = +(own + children).toFixed(4);
  if (node.children.some(child => child.cost.confidence === "partial" || child.cost.confidence === "n/a"))
    node.cost.confidence = node.cost.confidence === "n/a" ? "n/a" : "partial";
}

/** The first provider that claims a path argument, or null if none does. */
export function refFromPath(absPath) {
  for (const p of PROVIDERS) {
    const ref = p.refFromPath(absPath);
    if (ref) return ref;
  }
  return null;
}

// A signpost, not a new module: describe() and workspace() are provider-neutral
// in fact -- they read only generic tree fields (cwd, repo, firstPrompt, branch,
// skills, identity, summary) and branch on nothing Claude-specific. They live in
// claude.mjs for historical reasons only, and relocating them is deferred; being
// reachable through the registry is what lets cli.mjs and server.mjs stop naming
// a provider, which is the actual requirement.
export { describe, workspace } from "./claude.mjs";
