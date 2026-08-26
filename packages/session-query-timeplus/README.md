# @timeplus/dsh-session-query

A `SessionQueryEngine` (`ctx.sessionQuery`) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) that answers **cross-session full-text search** as push-down streaming SQL
over a [Timeplus](https://timeplus.com) / Proton index — the query companion to
[`@timeplus/dsh-session-persistence`](https://www.npmjs.com/package/@timeplus/dsh-session-persistence).

Where the persistence provider makes a Timeplus stream the durable session log,
this engine derives a searchable index from it (and from live sessions) and runs
`searchSessions` / `searchEvents` against the whole fleet in one store — no
per-node full-text index to build and reconcile, unlike the SQLite engine.

## How it works

- **Semantic documents, extracted in TS.** Searchable text comes from the shared
  `buildSessionEventSearchDocuments` (surface-aware, event-type-specific), so raw
  chunks and structural events contribute nothing and assistant reasoning is
  excluded — identical to the first-party engines.
- **A derived index in Timeplus.** Two `versioned_kv` streams (`<index>_state`,
  `<index>_docs`) hold one row per session and per searchable event, upserted by
  primary key with a soft-delete flag. On each search the engine reconciles them
  from `ctx.sessionPersistence` (by revision) and live `ctx.sessions` (by content
  fingerprint), waits for read-your-writes visibility, then queries.
- **Push-down matching and ranking.** The query is treated as a literal
  case-insensitive token phrase and compiled to a RE2 pattern; Proton's `match()`
  filters and `count_matches()` ranks. Snippets are built in-process. Results are
  live-preferred (a live session hides its persisted copy) and cursor-paginated.

Only `searchSessions` and `searchEvents` are backend-specific; the exact reads,
filters, traces, and titles are inherited from the base `SessionQueryEngine`.

## Install & configure

Requires the `dsh` CLI, a reachable Timeplus/Proton, and (recommended) the Timeplus
persistence provider so search covers persisted sessions.

```sh
dsh plugin --profile <name> add @timeplus/dsh-session-query
```

In `$DSH_HOME/profiles/<name>/cordis.patch.yml`, insert it alongside the persistence
provider (both point at the same Timeplus):

```yaml
- insert:
    - id: session-query-timeplus
      name: '@timeplus/dsh-session-query'
      config:
        url: http://localhost:8123
        database: default
        indexStream: dsh_session_search   # <index>_state / <index>_docs are created
```

### Config

| Key | Default | Meaning |
|---|---|---|
| `url` | — (required) | Timeplus/Proton HTTP endpoint. |
| `database` | `default` | Database holding the index streams. |
| `indexStream` | `dsh_session_search` | Base name; `_state` / `_docs` are appended. |
| `username` / `password` / `apiKey` | — | Auth. |
| `bootstrapSchema` | `true` | Create the index streams at init. |
| `flushThresholdMs` | `200` | Index-write visibility bound. |
| `defaultLimit` / `maxLimit` | `20` / `100` | Page sizes. |
| `snippetChars` | `240` | Snippet length in code points. |

## Status

`dsh` is a developer preview. Verified against `@deepseek-ai/dsh@0.1.1-rc.2` and Proton
3.0.29. Single live writer per session id is a v1 deployment contract (shared with the
persistence provider). Source and tests:
[github.com/timeplus-io/dsh-timeplus](https://github.com/timeplus-io/dsh-timeplus).

## License

Apache-2.0
