# Instructions for coding agents

This repo holds Timeplus plugins for DeepSeek Harness (dsh). The first one,
`packages/session-persistence-timeplus` (`@timeplus/dsh-session-persistence`),
is a complete v1: a `SessionPersistence` provider that makes a Timeplus stream
the durable source of truth for the dsh session log. **DESIGN.md is the
authoritative design**; section references in code comments (§4.2 etc.) point
there. Read it before changing semantics.

## Layout

```
packages/session-persistence-timeplus/
  src/client.ts    HTTP client (POST-only, {name:type} params, basic auth / X-Api-Key)
  src/store.ts     PersistenceBackend<undefined>: appendBatch, loadStored[From],
                   readStoredRevision, commitRepair, list, listSnapshots
  src/codec.ts     row <-> event/header, verbatim JSON `data`, corruption errors
  src/revision.ts  the ONE revision formatter (loadStored + aggregate query agree)
  src/schema.ts    CREATE STREAM DDL (flush_threshold_ms set at CREATE time)
  src/index.ts     Service wiring — mirrors upstream session-persistence-sqlite
  tests/           see "Verify"; helpers.ts owns stream isolation
docker-compose.yml + docker/proton/config.d/dsh-dev.yaml   throwaway Proton for tests
vitest.config.ts   resolves @deepseek-ai/* from ../deepseek-harness source
scripts/typecheck.mjs   tsc against upstream source, vendor diagnostics filtered
```

## Ground rules (still binding)

1. **Upstream lives next to this repo**: `git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness && (cd ../deepseek-harness && pnpm install)`.
   Verified commit is recorded at the top of DESIGN.md; on a bump, re-run
   everything and update it. Authoritative references inside upstream:
   - `packages/session/session-persistence/src/coordinator.ts` — the
     `PersistenceBackend` contract (doc comments are the spec).
   - `packages/session/session-persistence-sqlite/` — the provider this mirrors.
   - `packages/session/session-persistence/tests/{contract,coordinator-contract}.ts`
     — conformance suites, mounted by `tests/contract.spec.ts`.
   - `.agents/notes/implemented/architecture/` — session-persistence,
     session-preparation, bounded write batching, log version mechanism.
2. **Never mutate returned graphs, never retain them** — the coordinator freezes
   and publishes them in place.
3. `data` columns are verbatim JSON envelopes; extracted columns
   (`type/turn/step/event_time`) are query sugar only. Losslessness is a hard
   requirement — the differential suite vs SQLite enforces it.
4. Torn markers stay `undefined` end to end (§4.3). A Timeplus batch cannot
   half-commit; if you find yourself writing truncation logic, stop.
5. Every write resolves only after read-your-writes (§4.2). Any new write path
   must go through `TimeplusStore.appendRows` (watermark pre-check → one ingest
   → `awaitVisible`), never call `client.ingest` directly from store logic.
6. Session ids and other values go into SQL as `{name:type}` parameters;
   identifiers go through `quoteIdentifier`. No string interpolation of data.
7. Upstream is a moving preview. `pnpm build` (tsconfig.json) compiles against
   the published `@deepseek-ai/*` packages pinned as devDependencies
   (`0.1.1-rc.2`, matching the verified commit); peers use `^` ranges. On an
   upstream bump: update the checkout, the pinned devDependencies, DESIGN.md's
   verified commit, and re-run everything including the install path below.

## Verify

```sh
docker compose up -d                                   # Proton with dev config
TIMEPLUS_URL=http://localhost:8123 pnpm test           # 7 files, ~15 s
pnpm typecheck
```

Suites (all skip without `TIMEPLUS_URL` except codec):
- `contract.spec.ts` — upstream persistence (12) + coordinator (40) contracts.
- `differential.spec.ts` — timeplus vs sqlite on random logs (fast-check;
  `DSH_DIFFERENTIAL_RUNS=100` for a fuller sweep).
- `durability.spec.ts` — the §4.2 probe (prints measured ack/visibility lag),
  atomic materialization, lost-ack retry idempotence.
- `revision.spec.ts` — store primitives, format refusal, abort signals.
- `resume.spec.ts` — live Session → provider restart → `prepare()` resume.
- `smoke.spec.ts` — the real thing: upstream's headless-agent composition
  booted through the Loader (keyless mock LLM) in a child `tsx` process with
  this provider patched in, run, restart, `ctx.agents.resume`. Set
  `DSH_SMOKE_STREAM=<name>` to keep the stream for manual inspection.
- `codec.spec.ts` — offline unit tests.

## Facts that cost time to learn (keep current)

- **Module resolution**: `vitest.config.ts` resolves every `@deepseek-ai/*`
  import from upstream source via upstream's `tsconfig.base.json` paths (a
  `@deepseek-ai/dsh-*` wildcard) using `ts.resolveModuleName`;
  `tsconfig.typecheck.json` extends that file; tests import upstream test
  helpers by relative path (`../../../../deepseek-harness/...`). Vendor
  packages (cordis/cosmokit/schemastery) don't compile under our strict flags,
  so `scripts/typecheck.mjs` filters their diagnostics.
- **Proton (3.0.29)**: DDL and queries must be HTTP POST (GET is read-only).
  Ingest ack ≠ `table()` visibility — bounded by the stream's
  `flush_threshold_ms`, which can only be set at CREATE. `TRUNCATE STREAM` is
  likewise async (~60 ms). int64/enum come back as plain JSON numbers/strings.
  `max_if` over zero rows returns 0, so the watermark query uses counts.
- **Disk**: every Proton stream preallocates a 2 GB NativeLog segment, and
  dropped streams purge only every 5 minutes. Creating a stream per test
  filled a 268 GB Docker VM once. Use `docker-compose.yml` (64 MB segments,
  no preallocation) for test servers, and never create a stream per test.
- **Test isolation**: primitive tests use `freshStore()` (own stream, dropped);
  the long suites use `useSharedStream()` (one stream per file, truncated and
  read back to empty before each test). `dsh_store_identity` is shared per
  database and is fine to leave behind.
- **Profile patching**: a cordis `patches` entry cannot change a row's plugin
  `name` (skipped with "name mismatch"). To install this provider: disable the
  base bundle's `session-persistence-jsonl` row and `insert` a new row — README
  shows the shape, and `smoke.spec.ts` generates exactly that config.
- **Install path (verified)**: `pnpm pack` the package, then with the published
  CLI: `dsh --profile headless --dump-config` (initializes
  `$DSH_HOME/profiles/headless`), `dsh plugin --profile headless add <tgz>`
  (pnpm in the profile dir; `@deepseek-ai/*` peers resolve through dsh's flat
  fallback `$DSH_HOME/profiles/node_modules`, so no duplicate coordinator),
  edit the profile's `cordis.patch.yml`, run. Without `DEEPSEEK_API_KEY` the
  session still boots and persists up to the credential error — enough to see
  rows land in `dsh_session_events`.
- **Resume mechanics**: a resumed Session appends a `session/end-seed` marker
  before any new events; expect it in seq/row counts.

## Roadmap (DESIGN.md §8)

Session lease for safe shared stores (§4.5), optional analytics materialized
views, `@timeplus/dsh-session-query` (separate package, separate seam).
