// Regenerates src/pricing/snapshot.json, the offline last resort bundled with a
// release. Review the diff: it is exactly the prices that changed.
import fs from "node:fs";
import { buildSnapshot } from "../src/pricing/index.mjs";

// Bundle only the model families a coding-agent harness can report.
const keep = canon => /^(claude|gpt|o\d|codex|gemini)/.test(canon);
const snap = await buildSnapshot(undefined, keep);
fs.writeFileSync(new URL("../src/pricing/snapshot.json", import.meta.url), JSON.stringify(snap, null, 1) + "\n");
for (const [n, s] of Object.entries(snap.sources)) console.log(n, Object.keys(s.models).length, "models");
