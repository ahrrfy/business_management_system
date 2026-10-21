# Missing asset investigation — 2026-10-21

Base: `c7074ecbc0e8030ccb066dfc11e22d9c0dc22dde`.
Isolated branch: `session/runtime-asset-miss-20261021`.

## Hypothesis and causal boundary

H1: expected missing hashed-asset responses enter the global exception logger;
the resulting repeated serialization/output might be sufficient to trigger the
event-loop overload guard and HTTP503.

The first mechanism is confirmed locally against the c707 serving options:
`server/vite.ts` mounts `express.static` for `/assets` with `fallthrough:false`.
A missing file becomes a status404 error passed to the final Express handler in
`server/index.ts`; that handler calls `logger.error` before considering the status.
The real filesystem HTTP fixture reproduces one global exception-log entry per
missing-file request. The HTTP response itself remains 404 in this fixture.
This explains classification/log amplification, not why a production requester
selected an absent filename.

The existing production evidence establishes absent files and an explicit
normal-lane lag905ms/HTTP503 event for `catalog.posList`; its request origin and
the cause of the lag remain unestablished. No production log ranges, assets,
database contents, CI runs, or previous investigations were reread for this task.
The source trace shows that the overload guard issues503 when the worker's
smoothed lag exceeds the lane threshold. This identifies the response mechanism,
not the workload or resource that delayed the worker.

## Bounded experiment

Run with the pinned Node20 binary, without dotenv or application bootstrap:

```powershell
$env:NODE_ENV='production'
$env:TZ='UTC'
& 'C:/Users/alara/.codex/cache/node-v20.20.2-win-x64/node.exe' --import tsx scripts/probe-static-asset-miss.mjs
```

The checked-in [raw result](runtime-asset-miss-20261021.json) records four ABBA
trials. Each sends104 missing-file requests over13 synthetic asset names, paced
at25/second, and104 constant non-financial HTTP canaries. This approximates the
known 0510 aggregate missing-file rate, directed at one local process. It uses the
real JSON logger with an asynchronous local file destination and the unchanged
500ms production lag monitor/EWMA and normal-lane500ms guard threshold. No lag
injection, busy wait, forced GC, SQL, financial fixtures, or production traffic.

| Measurement | Before, two trials | After, two trials |
|---|---:|---:|
| Missing asset responses | 208 ×404 | 208 ×404 |
| Global exception-log events | 208 | 0 |
| Exception-log bytes | 90,576 | 0 |
| Constant canaries | 208 ×200 | 208 ×200 |
| Largest smoothed lag | 9.47ms | 11.64ms |
| HTTP503 | 0 | 0 |

The experiment does **not** reproduce lag905ms or503. H1's logging mechanism is
confirmed, but logging at this fixture's rate is not demonstrated sufficient to
explain the production overload. The timings do not establish a latency/CPU
improvement. Windows filesystem scheduling, background processes, PM2/nginx,
production log-pipe backpressure, real request mix, GC and DB timing are outside
this fixture. It neither proves nor clears any of those production causes.

## Prepared change

`createHashedStaticAssets` terminates status400/403/404/405 asset request errors
locally, with generic bodies and `Cache-Control: no-store`. Missing hashes cannot
reach SPA rendering or the generic exception/Sentry path. Success still serves
the exact bytes with one-year immutable caching, HEAD, ETag304 and ranges206.
Non-GET/HEAD methods return405 with `Allow: GET, HEAD`. Directory redirects are
disabled; other routes continue through the existing application chain.

Real server/filesystem errors still propagate: an EIO fault produces500 and
reaches the final error handler. The boundary also delegates errors after headers
have been sent. It does not copy historical bundles, invent a replacement hash,
change global logging, modify overload thresholds, or claim to recover an absent
production asset.

## Validation and status

- Red: the unchanged c707 asset-serving options fail the missing/invalid-path
  boundary tests (2 failed, 3 passed).
- Green:25 tests across the new asset fixture, existing runtime-static router and
  existing overload guard pass; Vitest reports `setup 0ms` and imports no DB setup.
- Node20 server esbuild bundle succeeds, without starting the application.
- Independent read-only review: PASS; no actionable findings in serving,
  traversal protection, genuine-error propagation or cache/HEAD/range contracts.
- `pnpm check`: PASS (exit0).
- `pnpm check:guards`: PASS (exit0), including ESLint and the46 registered guards.
  Existing informational ratchet/friction findings were not modified.
- `git diff --check`: PASS. No full financial/integration suite was run locally.

Production acceptance remains **PENDING**. Historical failed windows/deployments
and their pins are unchanged. There is no production deployment, new acceptance
baseline/window, financial data access or Q2B1 activation. This is a locally
verified containment repair for expected asset404s; the source of absent-asset
requests and the underlying production lag/503 failure remain unresolved.
