# agent-atlas

Provider-agnostic cost & agent-tree explorer for AI coding sessions.
**Zero dependencies** — Node 22 stdlib only. No outbound network, no telemetry,
binds `127.0.0.1` by default.

Reads the transcripts your agent harness already writes, builds a nested tree of
every agent that ran (orchestrator → subagents → their subagents, any depth),
prices every node from its own token usage, and rolls costs up:
`total = own + Σ children.total`.

```
orchestrator — (session root)                 opus-5 high 19.4h 251c  $323.17 (own $81.76 + sub $241.41)
├─ lib-researcher — Survey tracing options    opus-5 xhigh 12m 41c    $6.08 (own $3.80 + sub $2.28)
│  ├─ general-purpose — Research Langfuse…    opus-5 xhigh 5m 19c     $1.07
…
```

## Usage

```bash
node src/cli.mjs list [--days 7 | --all] [--json]      # sessions, cost-so-far, LIVE badge
node src/cli.mjs tree <session-id|path> [--json|--html] # expandable tree (terminal/JSON/HTML)
node src/cli.mjs export <id> --out tree.html            # standalone HTML, no server needed
node src/cli.mjs serve [--host 127.0.0.1] [--port 4747] [--interval 10] [--token X]
```

Web view: `/` session list · `/session/<id>` expandable tree ·
`/api/sessions`, `/api/tree/<id>` JSON. With `--token X` every request must
carry `?t=X` (use it if you bind beyond localhost).

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

Change detection is a stat scan every `--interval` seconds (no inotify: with
~1k sessions a scan costs milliseconds and avoids watcher edge cases).

## Providers

`src/providers/<name>.mjs` implements: `discover()` → session refs, and
`buildTree(sessionPath, cache)` → tree. Implemented:

- **claude** (Claude Code): sessions in `~/.claude/projects/<proj>/<uuid>.jsonl`
  (override root with `AGENT_ATLAS_CLAUDE_ROOT`); harness subagents from
  `<uuid>/subagents/agent-*.jsonl` + `.meta.json` sidecars (`agentType`,
  `description`, `parentAgentId`, `spawnDepth`); cost per node computed from
  per-message usage with the 5m/1h cache-tier split.

## Human effort

Every node carries what a person actually contributed, as its own datum next to
the spawn structure — *where in a run was human visibility needed*:

- `prompts` — messages a human typed. Only a root session has a person on the
  other end, so a spawned agent's user-role lines (its spawn prompt, anything
  its parent sent after) are not human input. Harness machinery that also
  arrives as a `type:"user"` line — `<system-reminder>` / `<task-notification>`
  injections, interruption markers, skill preambles, compaction preambles — is
  excluded by the same predicate that picks the session's `firstPrompt`.
- `decisions` — `AskUserQuestion` gates the human answered, matched `tool_use` →
  `tool_result` by id. They arrive as tool results, never as prompts, and are
  the one place a human decision enters an otherwise autonomous run.
- `interactions` — each answered gate: its questions (header, body, option
  labels) and the answers chosen, plus the raw answer text.

Planned (design notes, not yet implemented):

- **codex**: `~/.codex/state_5.sqlite` (`threads` incl. free-text `source`,
  `thread_spawn_edges` for native parent/child) + `thread_turns` timings +
  rollout JSONL for tokens, via `node:sqlite`. No dollar figure exists anywhere
  in Codex's store — costs would be list-price × tokens, flagged `computed`.
- **cursor**: nothing to read — Cursor persists no billable usage locally and
  its headless CLI reports no cost (open feature request). Cursor-launched
  work appears via the launch ledger below, cost `n/a`.

## The launch ledger (`launches.jsonl`)

Agents launched **by CLI** (e.g. `claude -p`, `codex exec`) leave no
parent→child link on disk. Whoever launches them closes that gap by appending
one JSON line to `<session-dir>/launches.jsonl` (sibling of `subagents/`):

```json
{"parentAgent": null,                    // or the agentId of the spawning subagent
 "provider": "claude",                   // claude | codex | cursor | …
 "agent": "flow9-design-round1-refuter", // caller-chosen identity
 "description": "refute finding F1",
 "childSession": "<uuid>",               // caller-chosen --session-id
 "childTranscript": "/abs/path.jsonl",   // known BEFORE launch (deterministic link)
 "phase": "design", "round": 1,          // optional metadata, free-form
 "reported": {"costUsd": 0.002234}}      // whatever the CLI reported on exit
```

Claude-provider entries are grafted as full recursive subtrees (their own
subagents and ledgers included) with cost recomputed from the child transcript;
other providers appear as leaves with `reported` data. Cost confidence is
labeled per node: `verified` / `computed` / `reported` / `n/a`.

## Pricing

`src/prices.mjs`. Anthropic list prices with cache multipliers (0.1× read,
1.25× 5m write, 2× 1h write) **validated to 8 decimals against the harness's
own `total_cost_usd`** for `haiku-4-5` and `opus-5`; other models use the same
multipliers and are flagged `computed`. Sonnet 5's introductory window
(≤ 2026-08-31) is handled.

## Caveats

- The harness sweeps transcripts after `cleanupPeriodDays` (default 30). v1 is
  in-memory over what's on disk; durable retention would add a store later.
- `list`/startup parse everything discovered once (~seconds); after that,
  incremental.

## Docker

Published to GHCR by CI on every push to `main` (and semver tags):

```bash
docker run --rm -p 4747:4747 \
  -v "$HOME:/data/home:ro" -e AGENT_ATLAS_CLAUDE_ROOT=/data/home/.claude/projects \
  ghcr.io/daimonbot/agent-atlas:latest
```

The image runs as user `node` (uid 1000), needs only a read-only mount of the
home that contains the transcripts, and writes nothing.
