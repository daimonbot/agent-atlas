#!/usr/bin/env node
// Refresh the bundled price snapshot (src/pricing/snapshot.json) from the live
// sources, with the same parsers and the same append-only merge the runtime
// uses. Run it before a release and review the diff: an entry is only ever
// appended, so the diff shows exactly which prices changed and since when.
//
//   npm run prices:snapshot                       # fetch every source
//   npm run prices:snapshot -- anthropic=page.md  # read a saved page instead
import fs from "node:fs";
import { SOURCES } from "../src/pricing/sources.mjs";
import { snapshotFile, readStore, writeStore, build, observe } from "../src/pricing/index.mjs";

const files = Object.fromEntries(process.argv.slice(2).map(a => a.split("=")));
const snapshot = readStore(snapshotFile);
const observedAt = new Date().toISOString();
let failed = 0;
for (const source of SOURCES) {
  try {
    const text = files[source.vendor] ? fs.readFileSync(files[source.vendor], "utf8")
      : await (async () => { const r = await fetch(source.url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })();
    const rows = source.parse(text);
    const added = observe(snapshot, build(snapshot, { entries: [] }).byKey, source, rows, observedAt);
    snapshot.sources[source.vendor] = { page: source.page, url: source.url, retrievedAt: observedAt, models: rows.length };
    console.log(`${source.vendor}: ${rows.length} models, ${added} new entr${added === 1 ? "y" : "ies"}`);
  } catch (e) { failed++; console.error(`${source.vendor}: ${e.message}`); }
}
writeStore(snapshotFile, snapshot);
process.exit(failed ? 1 : 0);
