# dsh-timeplus

Timeplus plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

dsh models every agent session as an **append-only log** of typed `SessionEvent`s — the
single source of truth that resume, fork, replay, transcripts, and the UI all derive
from. A [Timeplus](https://timeplus.com) stream is the same shape. This repo makes the
stream the durable store, so your agent fleet's canonical logs are also live,
queryable data: token spend, tool latency, error rates, and guardrail policies as
streaming SQL — with no export pipeline.

## Packages

| Package | Seam | Status |
|---|---|---|
| [`@timeplus/dsh-session-persistence`](packages/session-persistence-timeplus) | `ctx.sessionPersistence` — durable source of truth | v1: passes the upstream persistence + coordinator contract suites (see [DESIGN.md](DESIGN.md)) |
| `@timeplus/dsh-session-query` (planned) | `ctx.sessionQuery` — fleet-scale search & traces | — |

Telemetry mirroring needs no plugin: point `dsh-session-telemetry-otel` at the
Timeplus OTel ingest endpoint.

## Usage

In your profile's `cordis.patch.yml`, disable the bundle's JSONL persistence
row and insert this provider (a patch cannot change a row's plugin name; find
the row id with `dsh --profile web --dump-config`):

```yaml
- id: persistence                     # the bundle's '@deepseek-ai/dsh-session-persistence-jsonl' row
  disabled: true
- insert:
    - id: timeplus-persistence
      name: '@timeplus/dsh-session-persistence'
      config:
        url: http://localhost:8123    # Timeplus/Proton HTTP endpoint
        database: default
        stream: dsh_session_events
        # username / password, or apiKey for Timeplus Enterprise/Cloud
        flushThresholdMs: 200         # ingest-to-queryable lag bound (DESIGN.md §4.2)
```

`tests/smoke.spec.ts` does exactly this against upstream's headless-agent
composition: one process runs a tool-using turn, a second process resumes the
session id from the stream and continues it.

The provider creates `dsh_session_events` (and a tiny `dsh_store_identity`)
on first start. Every session event is one row whose `data` column holds the
verbatim JSON envelope; `session_id`, `seq`, `type`, `turn`, `step`, and
`event_time` are extracted for querying:

```sql
SELECT session_id, count() AS events, max(event_time) AS last_seen
FROM table(dsh_session_events) WHERE kind = 'event' GROUP BY session_id;
```

One live writer per session id is a deployment contract in v1 (DESIGN.md §4.5).

## Development

The `@deepseek-ai/*` packages on npm lag the upstream repo, so this package
builds and tests against a sibling checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
(cd ../deepseek-harness && pnpm install)   # tests import upstream sources directly
pnpm install
docker compose up -d                         # Proton with small NativeLog segments
TIMEPLUS_URL=http://localhost:8123 pnpm test
pnpm typecheck
```

Without `TIMEPLUS_URL` only the offline unit tests run. Use the compose file
(or `docker/proton/config.d/dsh-dev.yaml`) for test servers: a default
Proton preallocates a 2 GB segment per stream, and the suites create a few.

Start with [DESIGN.md](DESIGN.md), then [CLAUDE.md](CLAUDE.md).

## Status

dsh is a developer preview and promises compatibility-breaking changes. The
commit this was verified against is recorded in DESIGN.md; re-run the
conformance suites on every upstream bump.

## License

Apache-2.0
