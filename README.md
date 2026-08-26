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
| [`@timeplus/dsh-session-query`](packages/session-query-timeplus) | `ctx.sessionQuery` — fleet-scale full-text search over the event stream | v1: push-down search + ranking + cursors against live Proton ([#1](https://github.com/timeplus-io/dsh-timeplus/issues/1)) |

Telemetry mirroring needs no plugin: point `dsh-session-telemetry-otel` at the
Timeplus OTel ingest endpoint.

## Install into a dsh profile (no source checkout needed)

Works with the published CLI (`@deepseek-ai/dsh@0.1.1-rc.2`) and a reachable
Timeplus/Proton. Until this package is on npm, build the tarball yourself:

```sh
# 1. build the plugin tarball (once)
git clone https://github.com/timeplus-io/dsh-timeplus && cd dsh-timeplus
pnpm install && (cd packages/session-persistence-timeplus && pnpm pack --pack-destination /tmp)

# 2. install dsh and initialize a profile (web or headless)
npm install -g @deepseek-ai/dsh          # or: npx @deepseek-ai/dsh ...
dsh --profile headless --dump-config >/dev/null   # creates $DSH_HOME/profiles/headless

# 3. add the plugin to the profile (forwards to pnpm; peers resolve from dsh's own install)
dsh plugin --profile headless add /tmp/timeplus-dsh-session-persistence-0.0.1.tgz
```

Then edit `$DSH_HOME/profiles/headless/cordis.patch.yml` (default `DSH_HOME`
is `~/.dsh`): disable the base bundle's JSONL row and insert this provider. A
patch cannot change a row's plugin name, hence disable + insert.

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
        flushThresholdMs: 200         # ingest-to-queryable lag bound (DESIGN.md §4.2)
```

Verify with `dsh --profile headless --dump-config` (the JSONL row shows
`disabled: true`, yours appears at the end), then run a session:

```sh
export DEEPSEEK_API_KEY=...
dsh --profile headless "reply with the single word pong"
curl -s -X POST http://localhost:8123/ --data-binary \
  "SELECT session_id, seq, type FROM table(dsh_session_events) ORDER BY seq FORMAT PrettyCompact"
```

Every event of the session is now a row; `dsh --profile web` sessions land in
the same stream if you patch the `web` profile the same way. Resuming a
session (`--resume <id>` in apps that support it) reads it back from the
stream.

`tests/smoke.spec.ts` automates the same patch shape against upstream's
headless-agent composition with a keyless mock LLM: one process runs a
tool-using turn, a second process resumes the session id and continues it.

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

`pnpm build` compiles against the published `@deepseek-ai/*` packages
(devDependencies pinned to `0.1.1-rc.2`). The test suites, however, mount
upstream's own contract suites, which are not published, so they run against
a sibling checkout:

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

A `Makefile` wraps the common flows (`make help` lists them):

```sh
make install
make proton-up test        # start Proton, run the full suite
make typecheck
```

Start with [DESIGN.md](DESIGN.md), then [CLAUDE.md](CLAUDE.md).

## Releasing

The two packages version and release **independently**, each tagged
`<npm-name>@<version>` (e.g. `@timeplus/dsh-session-query@0.0.1`). GitHub
Releases are per package with per-package notes; a monorepo has no single
"latest", so releases are created with `--latest=false`.

```sh
make bump-query VER=patch          # edit packages/.../package.json, then commit
make release-query                 # build → npm publish → scoped tag → GitHub release
```

`make release-<pkg>` refuses a dirty tree (override with `ALLOW_DIRTY=1`), and
the granular steps (`publish-*`, `tag-*`, `gh-release-*`) are available too.
Requires `npm` logged in and `gh` authenticated.

## Status

dsh is a developer preview and promises compatibility-breaking changes. The
commit this was verified against is recorded in DESIGN.md; re-run the
conformance suites on every upstream bump.

## License

Apache-2.0
