# @timeplus/dsh-session-persistence

A [`SessionPersistence`](https://github.com/deepseek-ai/deepseek-harness) provider for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) that makes a
[Timeplus](https://timeplus.com) / Proton stream the **durable source of truth** for the
agent session log.

dsh models every agent session as an append-only log of typed `SessionEvent`s — the single
source of truth that resume, fork, replay, transcripts, and the UI all derive from. This
provider stores that log as one Timeplus stream, so your fleet's canonical session logs are
also live, queryable data: token spend, tool latency, error rates, and guardrail policies as
streaming SQL, with no export pipeline. It implements the same `PersistenceBackend` contract
as the first-party SQLite and JSONL backends and delegates orchestration to the shared
`PersistenceCoordinator`, so resume/fork/replay/`readFrom` all work unchanged.

## Install

Requires the `dsh` CLI and a reachable Timeplus/Proton (`docker run -p 8123:8123 timeplus/proton`).

```sh
# add the plugin to a dsh profile (web or headless)
dsh plugin --profile headless add @timeplus/dsh-session-persistence
```

npm may warn about unmet `@deepseek-ai/*` peer dependencies — that is expected. dsh satisfies
them at boot from its own installation (via `$DSH_HOME/profiles/node_modules`), so the plugin
shares dsh's single copy of the session coordinator rather than bundling a second one.

## Configure

A cordis patch cannot change a row's plugin name, so **disable** the base bundle's JSONL
persistence row and **insert** this provider. Edit
`$DSH_HOME/profiles/<name>/cordis.patch.yml` (default `DSH_HOME` is `~/.dsh`):

```yaml
- id: session-persistence-jsonl       # the row from @deepseek-ai/dsh-base
  disabled: true
- insert:
    - id: session-persistence-timeplus
      name: '@timeplus/dsh-session-persistence'
      config:
        url: http://localhost:8123    # Timeplus/Proton HTTP endpoint
        database: default
        stream: dsh_session_events
        # username / password, or apiKey for Timeplus Enterprise/Cloud
        flushThresholdMs: 200         # bounds the ingest→queryable lag (see below)
```

Verify the composed tree with `dsh --profile <name> --dump-config` (the JSONL row shows
`disabled: true`; yours appears at the end). The provider creates `dsh_session_events` and a
tiny `dsh_store_identity` stream on first start.

### Config reference

| Key | Default | Meaning |
|---|---|---|
| `url` | — (required) | Timeplus/Proton HTTP endpoint. |
| `database` | `default` | Database holding the streams. |
| `stream` | `dsh_session_events` | Canonical event stream name. |
| `username` / `password` | — | Basic auth. |
| `apiKey` | — | Timeplus Enterprise/Cloud API key (`X-Api-Key`). |
| `bootstrapSchema` | `true` | `CREATE STREAM IF NOT EXISTS` at init. |
| `flushThresholdMs` | `200` | Stream `flush_threshold_ms` set at CREATE; bounds how long an append waits for read-your-writes visibility. Set at creation time only. |
| `visibilityPollIntervalMs` | `20` | Poll cadence while waiting for an acknowledged batch to become queryable. |
| `visibilityTimeoutMs` | `30000` | Max wait for visibility before an append fails. |
| `writeBatchMaxDelayMs` | `200` | Coordinator write-batching window (coalesces streaming chunks). |
| `preparedSessionCacheSize` | `5` | Cold-preparation LRU size for resume. |

## Query the log

Every session event is one row whose `data` column holds the verbatim JSON envelope;
`session_id`, `seq`, `kind`, `type`, `turn`, `step`, and `event_time` are extracted for querying.

```sql
-- events per session
SELECT session_id, count() AS events, max(event_time) AS last_seen
FROM table(dsh_session_events)
WHERE kind = 'event'
GROUP BY session_id;

-- one session in order
SELECT seq, type, turn, step
FROM table(dsh_session_events)
WHERE session_id = '<id>'
ORDER BY seq;
```

## How it works

- **One append stream, verbatim payloads.** The `data` column reproduces each `SessionEvent`
  byte-faithfully (raw `assistant/chunk` events included); extracted columns are query sugar.
  Losslessness is enforced by a differential test suite against the SQLite backend.
- **Read-your-writes durability.** On Proton an ingest acknowledgement does not imply immediate
  `table()` visibility — rows surface after the stream's `flush_threshold_ms`. Each append
  ingests the batch as one request, then polls its own watermark until the rows are queryable
  before resolving, so the coordinator's later reads are always consistent.
- **Atomic lazy materialization.** A session's header row rides in the same ingest batch as its
  first events, so a crash never leaves a materialized-but-empty session; a created-but-never-
  appended session leaves nothing behind.
- **No torn tails.** A Timeplus ingest batch commits atomically or not at all, so crash repair
  reduces to appending the coordinator's synthetic closers — there is no truncation path.

## Deployment notes

- **One live writer per session id** is a v1 deployment contract (the coordinator assumes a
  single owner per id; a shared-store lease is on the roadmap).
- **`supportsRawArtifacts = false`**, like SQLite: there is no per-session file artifact.
- Telemetry mirroring needs no plugin — point `dsh-session-telemetry-otel` at the Timeplus
  OTel ingest endpoint.

## Status

`dsh` is a developer preview and promises compatibility-breaking changes. This release is
verified against `@deepseek-ai/dsh@0.1.1-rc.2` and Proton 3.0.29. Source, design notes, and the
full test suite (upstream persistence + coordinator contracts, Timeplus-vs-SQLite differential,
durability probe, CLI smoke test) live at
[github.com/timeplus-io/dsh-timeplus](https://github.com/timeplus-io/dsh-timeplus).

## License

Apache-2.0
