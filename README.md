# agent-atlas

Provider-agnostic cost & agent-tree explorer for AI coding sessions.
**React 19 + Vite UI**, backed by a Node 22+ server. No runtime outbound network, no telemetry,
and binds `127.0.0.1` by default.

Reads the transcripts your agent harness already writes, builds a nested tree of
every agent that ran (main → subagents → their subagents, any depth),
prices every node from its own token usage, and rolls costs up:
`total = own + Σ children.total`.

```
main — (session)                              opus-5 high 19.4h 251c  $323.17 (own $81.76 + sub $241.41)
├─ lib-researcher — Survey tracing options    opus-5 xhigh 12m 41c    $6.08 (own $3.80 + sub $2.28)
│  ├─ general-purpose — Research Langfuse…    opus-5 xhigh 5m 19c     $1.07
…
```

## Usage

Install and build the browser client once:

```bash
npm install
npm run build
```

Then use the CLI:

```bash
node src/cli.mjs list [--days 7 | --all] [--json]      # sessions, cost-so-far, LIVE badge
node src/cli.mjs tree <session-id|path> [--json|--html] # expandable tree (terminal/JSON/HTML)
node src/cli.mjs export <id> --out tree.html            # standalone HTML, no server needed
node src/cli.mjs serve [--host 127.0.0.1] [--port 4747] [--interval 10] [--token X]
```

Web view: `/` is a Vite-built React application and `/session/<id>` is its React detail route. The list uses a worker-backed session index, server-side filtering/sorting/aggregates, paged JSON and bounded virtual rows, so the initial UI payload and mounted DOM do not grow with the complete history. Detail data is fetched only after navigating to a session.

Compatibility endpoints remain available: `/api/sessions` and `/api/tree/<id>`. The React UI uses additive `/api/ui/sessions` and `/api/ui/session/<id>` endpoints. With `--token X`, HTML and API requests require `?t=X`; fingerprinted static browser assets are intentionally public and contain no transcript data.

## Live sessions

Transcripts are append-only JSONL, so ingestion is incremental and idempotent:

1. Per file we keep a byte offset and parse only new, complete lines
   (a partial trailing line waits for the next pass).
2. Aggregation dedups by `message.id` keeping the MAX-usage variant — the same
   rule the harness uses for its own streaming duplicates — so re-reading any
   range converges to the same numbers. A live session's cost is a monotone
   lower bound of its final cost.
3. There is no "session closed" marker on disk, and none is needed: a session
   is **LIVE** if its file changed in the last 2 minutes; its tree is simply
   the tree so far, and live pages auto-refresh.

Change detection is a stat scan every `--interval` seconds. Parsing/indexing runs in a worker thread, so the HTTP listener and health endpoint become available before the initial corpus index completes. The UI reports this transient indexing state rather than presenting partial totals as final.

## Providers

`src/providers/<name>.mjs` implements: `discover()` → session refs, and
`buildTree(sessionPath, cache)` → tree. Implemented:

- **claude** (Claude Code): sessions in `~/.claude/projects/<proj>/<uuid>.jsonl`
  (override root with `AGENT_ATLAS_CLAUDE_ROOT`); harness subagents from
  `<uuid>/subagents/agent-*.jsonl` + `.meta.json` sidecars (`agentType`,
  `description`, `parentAgentId`, `spawnDepth`); cost per node computed from
  per-message usage with the 5m/1h cache-tier split.

Planned (design notes, not yet implemented):

- **codex**: `~/.codex/state_5.sqlite` (`threads` incl. free-text `source`,
  `thread_spawn_edges` for native parent/child) + `thread_turns` timings +
  rollout JSONL for tokens, via `node:sqlite`. No dollar figure exists anywhere
  in Codex's store — costs would be list-price × tokens, flagged `computed`.
- **cursor**: nothing to read — Cursor persists no billable usage locally and
  its headless CLI reports no cost (open feature request). Cursor-launched
  work has no local trace at all today.

**Transcript detection needs no cooperation from whoever launched the agent**,
which is why it is the only mechanism here: when a Bash
`tool_use` whose command mentions `codex` returns a `tool_result` carrying
codex's own `session id: <uuid>` line, agent-atlas emits one `CLI:codex` leaf
per distinct uuid per tree, under the agent whose transcript it was read from.
It is a stub — `cost` is always `0` / `n/a`, since no Codex price table
exists — and the banner fields it carries (`tokensUsed`, `sandbox`,
`workdir`, `approval`, `codexVersion`, under `reported`) are harvested
only from a complete printed banner; a grep or log re-read yields the session id
and nothing else. **Those `reported.*` key names are provisional**, and may be
replaced if a real `codex` provider module ever reads Codex's own store. Two
known false negatives: a launch whose output the harness spilled to
`<session-dir>/tool-results/<name>.txt` (that sibling file is never opened),
and a launch run as a background shell and read back via `BashOutput` (that
tool call carries no command to anchor on). Neither leaves a trace in the tree.

## Pricing

`src/prices.mjs`. Anthropic list prices with cache multipliers (0.1× read,
1.25× 5m write, 2× 1h write) **validated to 8 decimals against the harness's
own `total_cost_usd`** for `haiku-4-5` and `opus-5`; other models use the same
multipliers and are flagged `computed`. Sonnet 5's introductory window
(≤ 2026-08-31) is handled.

## Caveats

- The harness sweeps transcripts after `cleanupPeriodDays` (default 30). v1 is
  in-memory over what's on disk; durable retention would add a store later.
- The initial worker index remains corpus-sized; it is deliberately asynchronous so it does not delay the HTTP server.

## Docker

Published to GHCR by CI on every push to `main` (and semver tags):

```bash
docker run --rm -p 4747:4747 \
  -v "$HOME:/data/home:ro" -e AGENT_ATLAS_CLAUDE_ROOT=/data/home/.claude/projects \
  ghcr.io/daimonbot/agent-atlas:latest
```

The image runs as user `node` (uid 1000), needs only a read-only mount of the
home that contains the transcripts, and writes nothing.
