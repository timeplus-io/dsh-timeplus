# Design: Timeplus session persistence for DeepSeek Harness

Status: implemented (v1) · Target: `@deepseek-ai/dsh` developer preview (breaking changes expected upstream)

Verified against deepseek-harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
(`0.1.1-rc.2`, 2026-08-21) and Proton `3.0.29`: the upstream persistence
contract (12 tests) and coordinator-orchestration contract (40 tests) both pass,
plus this package's durability, primitive, codec, and Timeplus-vs-SQLite
differential suites. The `@deepseek-ai/*` packages on npm (`0.0.1-rc.1`) predate
the coordinator seam, so the package currently builds and tests against a
sibling checkout of the upstream repo (see README → Development); pin real
versions once upstream publishes `0.1.x`.

## 1. Goal

Provide a `SessionPersistence` provider (`ctx.sessionPersistence`) that makes a
Timeplus stream the **durable source of truth** for the dsh append-only
`SessionEvent` log — not a mirror. Every capability that derives from the log
(resume, fork, replay, transcripts, `readFrom` watermark reads) works against
Timeplus, and the same stream is directly queryable with streaming SQL
(dashboards, materialized views, AgentGuard policies) with no export pipeline.

Non-goals (v1): multi-writer sessions, session-query provider (separate seam,
separate package later), raw artifacts (`supportsRawArtifacts = false`, like
SQLite), OTel telemetry (already covered by `dsh-session-telemetry-otel` →
Timeplus OTel ingest).

## 2. Where we plug in

dsh backends do NOT implement the full 8-method `SessionPersistence` service by
hand. First-party providers implement the small `PersistenceBackend` interface
and delegate everything else to the shared `PersistenceCoordinator`
(`@deepseek-ai/dsh-session-persistence`), which owns write-behind batching, seq
cursors, live adoption, crash-repair sequencing, prepared-session LRU caching,
and dispose quiescence. Mirror `session-persistence-sqlite/src/index.ts`
wiring exactly (see `src/index.ts` in this package).

Backend primitives to implement (see `src/store.ts`):

| Primitive | Timeplus implementation |
|---|---|
| `appendBatch(meta, events, isMaterialized)` | one ingest batch to `dsh_session_events`; when `!isMaterialized`, a `kind='header'` row rides in the SAME batch (atomic materialization, §4.1) |
| `loadStored(id)` | historical query `table(dsh_session_events)` filtered by `session_id`, ordered by `seq` |
| `loadStoredFrom(id, fromSeq)` | same + `seq >= fromSeq` → seek-capable `readFrom` (parity with SQLite, better than JSONL) |
| `readStoredRevision(id)` | one aggregate row (§4.4) |
| `commitRepair(meta, tornMarker, closers)` | append `kind='repair'` closer rows; torn tails cannot occur (§4.3), so `tornMarker` is always `undefined` |
| `list()` | query `kind='header'` rows (or the headers MV) |
| `locate` | `undefined` — no per-session local artifact |
| `close` | close HTTP client / driver |

The service additionally implements `listSnapshots()` directly against the
store (one GROUP BY query), as SQLite does.

## 3. Schema

One canonical append stream. `data` holds the verbatim lossless JSON payload —
the durable log must reproduce events byte-faithfully (including raw
`assistant/chunk` events); extracted columns exist purely for querying.

```sql
CREATE STREAM IF NOT EXISTS dsh_session_events (
  session_id string,
  seq        int64,               -- header rows use -1
  kind       enum8('header' = 0, 'event' = 1, 'repair' = 2),
  type       string,              -- '' for header rows; else SessionEvent type
  turn       int32 DEFAULT -1,    -- convenience extraction; -1 when absent
  step       int32 DEFAULT -1,
  event_time int64,               -- event append time (ms); header: createdAt
  data       string               -- verbatim JSON: SessionEvent.data or SessionHeader
);
```

Convenience projections (not load-bearing for the contract; safe to add later):

```sql
-- headers for cheap list()
CREATE MATERIALIZED VIEW IF NOT EXISTS dsh_session_headers AS
SELECT session_id, data AS header, event_time AS created_at
FROM dsh_session_events WHERE kind = 'header';
```

A store-identity row (random UUID written at bootstrap into a tiny
`dsh_store_identity` stream, first row wins) namespaces revisions so tokens
from different Timeplus stores never compare equal (§4.4).

## 4. Semantics mapping (the contract, point by point)

### 4.1 Atomic materialization
Contract: the materialize-write and the first event batch MUST commit
atomically — a crash must not leave a materialized-but-empty session.
Implementation: the header row and the first events are rows of ONE ingest
batch into ONE stream. A single-batch ingest commits atomically or not at all.
`list()` sees a session iff its header row exists, so an abandoned
created-but-never-appended session leaves nothing behind (lazy
materialization, as the contract permits).

### 4.2 Durability
Contract: `appendBatch` returns only after the batch is durable, and a
subsequent read must see it (the coordinator probes `loadStored` for create
collisions and adoption).

**Resolved (OPEN QUESTION #1):** on Proton the HTTP ingest ack means the batch
is committed to the stream's NativeLog (durable), but it is NOT immediately
visible to `table()` queries, which read the historical store. Measured with
`tests/durability.spec.ts`: ack ≈ 50–70 ms, visibility up to ~2.1 s with the
default stream setting `flush_threshold_ms = 2000`; ≈ 40 ms past the ack with
`flush_threshold_ms = 100`. One insert block flushes as a unit (the first
non-empty observation holds the whole batch), so visibility is atomic.

Implementation:
- The stream is created with `SETTINGS flush_threshold_ms = <flushThresholdMs>`
  (default 200, config knob). Timeplus does not allow altering it afterwards,
  so a pre-existing stream keeps whatever it was created with.
- `appendBatch`/`commitRepair` first read the session's watermark (one
  aggregate over `table()`), reject a non-contiguous batch (`append starts at
  seq X, stored next seq is Y`, mirroring SQLite), treat an exact re-send of an
  already-stored batch as an idempotent no-op (a write-behind retry after a
  lost ack must not duplicate rows), ingest the rows as one request, then poll
  the watermark every `visibilityPollIntervalMs` (20) until the batch's rows
  and the header are queryable, failing after `visibilityTimeoutMs` (30 s).
- Because every append resolves only after read-your-writes, all later
  `table()` reads (load, revision, list) are consistent with the cursor.
- `TRUNCATE STREAM` has the same ack-then-visible behavior (~60 ms); only the
  test helpers use it.

### 4.3 Crash repair / torn tails
File backends can crash mid-record and must truncate a torn physical tail.
A Timeplus ingest batch cannot half-commit, so `loadStored` NEVER returns a
`tornMarker` and `commitRepair` reduces to appending the coordinator-supplied
synthetic closers (`turn/end { reason: { kind: 'interrupted' } }` etc.) as
`kind='repair'` rows with their assigned seqs. Type the backend
`PersistenceBackend<undefined>`. No truncation path, no tombstones — this is
the biggest simplification vs. JSONL/SQLite.

### 4.4 Revisions
Contract: an opaque token that identifies one storage source and changes
whenever the stored log changes; repeated observation of an unchanged log
returns the same token; distinct stores never collide.
Implementation: `timeplus:{storeIdentity}:{sessionId}:{rowCount}:{maxIngestMs}`
derived by one aggregate query (`count()`, `max(to_unix_timestamp64_milli(_tp_time))`
over the session's rows); `loadStored` derives the same string from the rows it
fetched (`src/revision.ts` is the single formatter). Append-only + repair-append
means any change moves `rowCount`. `storeIdentity` is
`{uuid from dsh_store_identity}:{database}.{stream}`, so two providers on the
same database but different streams are still distinct sources.
Brand with `SessionPersistenceRevision(...)`.

### 4.5 Seq contiguity & single writer
The coordinator enforces contiguous seqs from its in-memory cursor and assumes
ONE live owner per session id (dsh session docs: concurrent writers need a
signal beyond the log). SQLite gets this from file locking; a shared Timeplus
store does not. v1: document single-writer per session id as a deployment
contract. v1.1 (recommended): lease via a mutable stream
`dsh_session_leases(session_id, owner, expires_at)` checked on
create/prepare — reject a second live owner. Do not attempt server-side seq
validation in v1.

### 4.6 Format refusal
Store the header verbatim; on load, a `SessionHeader.version` ahead of this
build's `SESSION_FORMAT_VERSION` throws `SessionFormatUnsupportedError` with
the upgrade direction, one behind states no upgrade path — mirror the SQLite
wording. Unknown event types are handled by the coordinator's generated
vocabulary check; the backend just returns rows faithfully.

### 4.7 Latency
Every flush checkpoint is now a network RTT. The coordinator's bounded write
batching (`writeBatchMaxDelayMs`) coalesces the hot path; this backend targets
server/team deployments, not laptop defaults. Expose the batching knob in
Config like SQLite does.

## 5. Read paths

- `loadStored`: fetch all rows for id ordered by seq; split header row from
  event rows; parse `data` (`src/codec.ts`); validate contiguity from 0;
  return fresh, unaliased object graphs (contract requires the backend retain
  nothing — the coordinator freezes them in place).
- `loadStoredFrom`: identical with `seq >= fromSeq`; also fetch the header
  row. Non-mutating; contiguity check scoped to the returned suffix.
- Cancellation: honor `AbortSignal` on all reads (wire into fetch).

## 6. Configuration

```yaml
# cordis.patch.yml — a patch cannot change a row's plugin name (cordis include
# skips it with "name mismatch"), so disable the JSONL row and insert ours.
- id: persistence                             # the bundle's jsonl row id
  disabled: true
- insert:
    - id: timeplus-persistence
      name: '@timeplus/dsh-session-persistence'   # final npm name TBD
      config:
        url: http://localhost:8123            # Timeplus query/ingest endpoint
        database: default
        stream: dsh_session_events
        username: ...
        password: ...                         # or apiKey for Timeplus Cloud/Enterprise
        bootstrapSchema: true                 # CREATE STREAM IF NOT EXISTS at init
        flushThresholdMs: 200                 # stream flush_threshold_ms at CREATE (§4.2)
        visibilityPollIntervalMs: 20          # read-your-writes poll cadence (§4.2)
        visibilityTimeoutMs: 30000
        writeBatchMaxDelayMs: 25
        preparedSessionCacheSize: 16
```

Discover the row id to patch with `dsh --profile web --dump-config`.
`tests/smoke.spec.ts` applies this exact shape to upstream's headless-agent
composition through the real Loader.

Operational notes learned from Proton 3.0.29:
- Every stream preallocates a 2 GB NativeLog segment by default
  (`data.datastore.log.segment_size` / `preallocate`), and dropped streams are
  purged only on the next retention check (5 min). The provider creates
  exactly two streams per store, which is fine; test suites that churn streams
  are not — `docker-compose.yml` ships a dev override (64 MB segments, no
  preallocation) and the contract suites reuse one truncated stream per file.
- All statements go over HTTP POST (GET is read-only); query parameters bind
  as `{name:type}` with `param_name=` in the URL, which is how session ids are
  passed (never interpolated). Identifiers (database, stream) must match
  `[A-Za-z_][A-Za-z0-9_]*` and are backtick-quoted.

## 7. Test plan

1. **Contract suites** — `runPersistenceContract` and `runCoordinatorContract`
   from `deepseek-harness/packages/session/session-persistence/tests/`
   against a live Proton/Timeplus (docker `timeplus/proton` in CI; skip when
   `TIMEPLUS_URL` unset). These are the same conformance suites JSONL and
   SQLite run: creation, append, resume, crash-closers, revision stability,
   live-session adoption/collision, HMR, dispose quiescence.
   `tests/contract.spec.ts` — 52 tests. No `corruptTail` injector: torn tails
   are structurally impossible here (§4.3).
2. **Differential** — `tests/differential.spec.ts`, ported from
   `session-persistence-sqlite/tests/differential.spec.ts` (fast-check):
   timeplus vs sqlite on identical random logs; every observable
   (inspect/list/readFrom for every seq, revision stability, remount) must be
   equal. 25 random runs by default (`DSH_DIFFERENTIAL_RUNS` to raise).
3. **Durability probe** — `tests/durability.spec.ts`, the §4.2
   read-your-writes integration test plus atomic materialization and
   lost-ack retry idempotence.
4. **Primitives** — `tests/revision.spec.ts`: revision stability/agreement
   across the three read paths, distinct stores, repair, suffix reads,
   listing order, abort signals, format refusal (§4.6), contiguity corruption.
5. **Unit** — `tests/codec.spec.ts`: codec round-trip (event ↔ row,
   header ↔ row), malformed-row errors, revision formatting, identifier
   quoting. Runs without a server.
6. **Resume** — `tests/resume.spec.ts`: a live Session driven through
   `ctx.sessions`, provider restart, `prepare()` resume, and the stream's row
   count growing.
7. **CLI smoke** — `tests/smoke.spec.ts`: upstream's headless-agent
   composition booted through the real Loader (`dsh-app-boot`, include +
   patches, keyless mock LLM) in a child `tsx` process with this provider
   patched in; a real bash tool round trip is persisted, a second process
   resumes the session id via `ctx.agents.resume` and continues it, and
   `count()` over the stream grows.

## 8. Roadmap after v1

- `dsh-session-query-timeplus`: the cross-session read/search seam
  (`packages/session-query/`) backed by streaming SQL — fleet-scale full-text
  and trace queries.
- Materialized views shipped as optional SQL: token spend per session/day,
  tool-call latency, error rates, active sessions.
- AgentGuard integration: streaming SQL policies over `dsh_session_events`
  and/or a `tools/pre-execute` waterfall plugin for inline enforcement.
- Session lease (§4.5) for safe shared stores.

## 9. Known upstream risks

dsh is a developer preview and promises compatibility-breaking changes; the
persistence seam changed as recently as 2026-08 (write batching, session
preparation). Pin exact `@deepseek-ai/*` versions and re-run the contract
suite on every bump. The upstream Agent Notes under
`.agents/notes/implemented/architecture/` (session-persistence,
session-preparation, bounded write batching, log version mechanism) are the
authoritative rationale — read them before changing semantics.
