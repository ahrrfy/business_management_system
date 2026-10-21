# Missing asset & overload investigation — 2026-10-21

Base: `c7074ecbc0e8030ccb066dfc11e22d9c0dc22dde`.
Isolated branch: `session/runtime-asset-miss-20261021`.

## 1. Root cause of repeated missing hashed-asset requests (`Dashboard-Cdl1COE7.js` bursts)

Forensic analysis of the production observation artifacts (`0040`–`0810`) and the client bundle lifecycle established two linked mechanisms behind the repeated missing-asset bursts (`394×` in `0510`, `56×` in `0515`, `140×` in `0525`, `15×` in `0635`, `20×` in `0725`):

1. **Why stale hashed filenames are requested on `/` after a deployment (`vite.config.ts`)**:
   - `VitePWA` is configured with `skipWaiting: false` and precaches `index.html` and the entry bundle `assets/app-*.js` (`globPatterns`), while lazy ERP route chunks (`Dashboard-*.js`, `Login-*.js`, etc.) are **not** precached (`runtimeCaching` caches `/assets/*` via `StaleWhileRevalidate` only after a chunk has been fetched at least once).
   - Although `vite.config.ts` restricted `navigateFallbackAllowlist` to `[ /^\/store(?:\/|$)/ ]` so that only `/store` routes would serve precached `index.html`, `workbox.directoryIndex` was left unset. In `workbox-precaching`, `PrecacheRoute` registers **before** `NavigationRoute` and defaults to `directoryIndex = "index.html"` in `generateURLVariations`. Consequently, every navigation to the ERP root `GET /` (`url.pathname === "/"`) had `"index.html"` appended by `PrecacheRoute` and was served the **stale precached `index.html` + `assets/app-OLD.js`** from the active Service Worker instead of reaching the network.
   - Furthermore, when `lazyWithRetry` called `window.location.reload()` while controlled by that stale Service Worker (`skipWaiting: false`, `decidePwaUpdateDelivery === "PROMPT"` on ERP routes), the reload immediately re-executed under the same old Service Worker and re-served the stale precached `index.html` + `assets/app-OLD.js`.

2. **Why `Dashboard` entered an infinite reload loop (`394×` / `140×`) while `Login` stopped at `count: 2` (`client/src/lib/lazyWithRetry.ts` + `client/src/App.tsx`)**:
   - In `client/src/App.tsx:664`, `<QuranStationDrawer />` is mounted unconditionally at the root of `<App />`, whereas `<Dashboard />` is mounted inside `<RootRoute />` only after `trpc.auth.me.useQuery()` resolves.
   - In `client/src/lib/lazyWithRetry.ts`, all ~140 lazy-loaded components shared a single global `sessionStorage` key (`RELOAD_GUARD_KEY = "alroya:chunk-reload-attempted"`), and **every** component's `try` block unconditionally executed `sessionStorage.removeItem(RELOAD_GUARD_KEY)` upon successful resolution (`line 51`).
   - **Proved by production log contrast**:
     - **When `QuranStationDrawer` was NOT cached (`0530` window)**: an unauthenticated client requested `Login-DQeKWJUm.js` (`count: 2`) and `QuranStationDrawer-Dz5S4onU.js` (`count: 2`). Because neither chunk was in `CacheStorage`, both failed over the network, neither entered the `try` success branch to call `removeItem`, and `lazyWithRetry` stopped after **1 reload (`count: 2` total requests)**.
     - **When `QuranStationDrawer` WAS already cached in `CacheStorage` (`0510`, `0515`, `0525`, `0635`, `0725` windows)**: on every reload, `<QuranStationDrawer />` resolved from `CacheStorage` in ~1ms (zero server requests for `QuranStationDrawer-*.js` in those windows) and called `sessionStorage.removeItem(RELOAD_GUARD_KEY)` *before* `<Dashboard />` mounted and received its network `404`. When `<Dashboard />` failed, `sessionStorage.getItem(RELOAD_GUARD_KEY)` was `null` (`alreadyReloaded === false`), so `<Dashboard />` set `RELOAD_GUARD_KEY = "1"` and called `window.location.reload()` again—repeating every ~450–650ms in an infinite reload loop:
       - `0510` (deploy `be92c6f1`): `394` reloads × `13` missing `Dashboard` dependency chunks = `5,122` `ENOENT` errors.
       - `0515` (deploy `be92c6f1`): `56` reloads × `13` chunks = `728` `ENOENT` errors.
       - `0525` (deploy `69ef4186`): `140` reloads × `4` uncached `Dashboard` chunks (`Dashboard-Cdl1COE7.js`, `LineChart-B231-sWx.js`, `BarChart-C_c9fnmB.js`, `GenerateCategoricalChart-B6435F5_.js`) = `560` `ENOENT` errors.
       - `0635` & `0725` (deploy `c7074ecb`): `15 × 4 = 60` and `20 × 4 = 80` `ENOENT` errors.

## 2. Explanation of the 4 withheld `0725` `public/assets` `stat` ENOENT events

In `production-observation-20261021-0725.json`, in addition to `20 × 4 = 80` `open` misses for the 4 `Dashboard` chunks above, `runtimeAssetMissSummary` recorded `assetNameWithheldCount: 4` (`time: 1792567630097`–`1792567632102`, `pid: 2777020`, `isCurrentRuntimePublicAsset: true`, `syscall: "stat"`, `messageLength`: `178, 177, 143, 171`).

- In `c7074ecbc0e8`, `app.use("/assets", express.static(assetsPath, { fallthrough: false }))` in `server/vite.ts` was the **only** middleware that forwarded `send` `ENOENT` errors to the global error handler in `server/index.ts` (`createRuntimeStaticAssets` handled `/fonts` and `/manifest.webmanifest` locally, and root `express.static(distPath)` used `fallthrough: true`).
- The prefix `ENOENT: no such file or directory, stat '/var/www/alarabiya/releases/20261021054217/dist/public/assets/'` is `136` characters (including the closing quote). Thus `messageLength` values `178, 177, 143, 171` correspond to 4 requests under `/assets/<subpath>` with relative path lengths `42, 41, 7, 35` that failed `send`'s initial `fs.stat` call and did not match the observation script's strict `safeAssetName` regex (`/^[A-Za-z0-9._-]+-\w{6,16}\.(?:js|css|mjs|map|woff2?|ttf|otf|png|jpe?g|webp|svg|ico)$/`, e.g. unhashed asset probes or nested subpaths under `/assets/...`).
- With `createHashedStaticAssets` in `server/staticAssets.ts`, all `[400, 403, 404, 405]` responses under `/assets`—whether `open` misses on hashed chunks or `stat` misses on unhashed/nested `/assets` paths—are terminated locally with `Cache-Control: no-store` and never reach the global exception logger.

## 3. Forensic analysis of the `0525` `lag=905ms` / `HTTP 503` event on `/api/trpc/catalog.posList`

`production-observation-20261021-0525.json` recorded a single `HTTP 503` overload-guard event:
- **Timestamp**: `1792560357102` (`2026-10-21T05:25:57.102Z`)
- **Worker PID**: `956338` (one of two PM2 cluster workers alongside `956337`, capped at `--max-old-space-size=512`)
- **Request**: `GET /api/trpc/catalog.posList` (`lane: "normal"`, `lagMs: 905`, `thresholdMs: 500`, `durationMs: 2`, `status: 503`)

Cross-referencing the `0520`, `0525`, and `0530` observation snapshots establishes three converging factors on worker `956338`:

1. **Client reload storm & synchronous error-log serialization (`05:24:18.704Z`–`05:25:50.687Z`)**:
   - Between `1792560258704` (`05:24:18.704Z`) and `1792560350687` (`05:25:50.687Z`), the `Dashboard` reload loop hit the server with `569` missing-asset requests (`140 × 4` `Dashboard` chunks + `9` probe misses), generating `569` unhandled Express `ENOENT` error-log entries (`530,366` log bytes), ending `6.415s` before the `503` event.
2. **Concurrent POS & storefront query surge during `0525`**:
   - Between `0520` and `0525` (same worker PIDs `956337`/`956338`), `catalog.posList` invocations jumped by **+29 calls** (`n = 14` in `0520` → `n = 43` in `0525`), with `catalog.posList` `p95Ms` rising from `186ms` to `291ms` (`maxMs = 401ms`), alongside **+168** `products.posCatalogVersion` calls (`815` → `983`) and heavy storefront batch queries (`product.list,storefront.Layout,storefront.listCategories,storefront.Thematic` at `p95Ms = 4252ms`, `maxMs = 6588ms`).
3. **V8 Major GC heap compaction near the 512 MiB ceiling on worker `956338`**:
   - In `0520`, worker `956338`'s V8 old-space was at **97.2% of its 512 MiB ceiling** (`usedMb: 464.93`, `totalMb: 484.91`, `rssMb: 575.45`).
   - In `0525` (captured ~22s after the `503`), worker `956338`'s old-space `totalMb` had compacted by **`-16.28 MiB`** (`usedMb: 455.63`, `totalMb: 468.63`, `95.9%` of limit)—the signature of a V8 Major Mark-Sweep-Compact cycle triggered under near-ceiling memory pressure.
4. **Overload guard mechanics (`server/middleware/overloadGuard.ts` + `server/middleware/requestPriority.ts`)**:
   - `overloadGuard.ts` samples event-loop lag every `500ms` using an EWMA (`alpha = 0.5`). `catalog.posList` is a read query classified in the `normal` priority lane (`thresholdMs = 500`), whereas cashier write/checkout procedures in `CRITICAL_CASHIER_PROCEDURES` run in the `critical` lane (`thresholdMs = 2000`). When worker `956338`'s smoothed lag reached `905ms` at `05:25:57.102Z`, `overloadGuard` shed the single `catalog.posList` request in `2ms` with `HTTP 503` (`Retry-After: 2`). No `critical` lane request was shed.

## 4. Bounded local experiment (server `/assets` error-log amplification)

Run with the pinned Node 20 binary, without dotenv or application bootstrap:

```powershell
$env:NODE_ENV='production'
$env:TZ='UTC'
& 'C:/Users/alara/.codex/cache/node-v20.20.2-win-x64/node.exe' --import tsx scripts/probe-static-asset-miss.mjs
```

The checked-in [raw result](runtime-asset-miss-20261021.json) records four ABBA trials (104 missing-file requests over 13 synthetic asset names at 25/second + 104 constant non-financial HTTP canaries per trial):

| Measurement | Before, two trials | After, two trials |
|---|---:|---:|
| Missing asset responses | 208 × 404 | 208 × 404 |
| Global exception-log events | 208 | 0 |
| Exception-log bytes | 90,576 | 0 |
| Constant canaries | 208 × 200 | 208 × 200 |
| Largest smoothed lag | 9.47ms | 11.64ms |
| HTTP 503 | 0 | 0 |

The synthetic local fixture confirms that missing `/assets` requests amplified global exception logging (`208` `ENOENT` error logs / `90,576` bytes → `0` after the fix), while also proving that isolated missing-asset logging alone (without production's 96–97% old-space heap pressure and concurrent `catalog.posList` / storefront DB workload) does not produce `lag=905ms` in an empty process.

## 5. Prepared changes

1. **Server `/assets` containment (`server/staticAssets.ts`, `server/vite.ts`, `server/__tests__/staticAssets.test.ts`)**:
   - `createHashedStaticAssets` terminates status `400/403/404/405` asset request errors locally with generic bodies and `Cache-Control: no-store`. Missing hashes and unhashed `/assets` probes cannot reach SPA rendering or the global exception/Sentry path.
   - Valid assets continue to serve with 1-year `immutable` caching, `HEAD`, `ETag` `304`, and `206` byte ranges. Genuine filesystem/I/O faults (`EIO`, `EACCES`, etc.) still propagate as `500` to the global error handler.
2. **Workbox `PrecacheRoute` navigation isolation (`vite.config.ts`, `scripts/verify-storefront-pwa-build.mjs`, `scripts/verify-storefront-pwa-build.test.mjs`)**:
   - Set `workbox.directoryIndex: null` in `vite.config.ts` so `PrecacheRoute` does not rewrite `GET /` to precached `index.html` ahead of `NavigationRoute` (`navigateFallbackAllowlist: [/^\/store(?:\/|$)/]`).
   - Added `assertStorefrontPrecacheNavigationPolicy` to `scripts/verify-storefront-pwa-build.mjs` (and unit tests in `scripts/verify-storefront-pwa-build.test.mjs`) to enforce `directoryIndex: null` in the built `dist/public/sw.js` artifact.
3. **Client `lazyWithRetry` reload-loop prevention & Service Worker recovery (`client/src/lib/lazyWithRetry.ts`, `client/src/lib/lazyWithRetry.test.ts`)**:
   - `lazyWithRetry` computes a normalized per-factory guard identifier (`getFactoryGuardValue(factory)`, stripping query strings, Vite's 8-character bundle hash, and `__vite__mapDeps([...])`) and stores `${guardValue}\n${Date.now()}` in `sessionStorage` with a 30-second TTL (`RELOAD_GUARD_TTL_MS = 30_000`), failing closed to `RouteErrorBoundary` if `sessionStorage.setItem` throws.
   - When a lazy component resolves in the `try` block, it only clears `RELOAD_GUARD_KEY` if the stored guard belongs to that same component (`parsed.target === guardValue`), is a legacy `"1"` guard, or has expired (`!parsed.active`). A cached sibling component such as `<QuranStationDrawer />` can no longer clear `<Dashboard />`'s pending reload guard before `<Dashboard />` fails.
   - When multiple uncached lazy components fail on the same page load (such as `<Login />` and `<QuranStationDrawer />`), `reloadEpoch` keeps sibling failures in `Suspense` while the first reload is in flight without erasing `RELOAD_GUARD_KEY` or flashing `ErrorBoundary`, and second-load failures retain the active TTL guard so subsequent failing sibling chunks on the second load also throw to their error boundaries instead of triggering another reload.
   - Recognizes Vite CSS preload errors (`Unable to preload CSS for` / `Loading CSS chunk \S+ failed`) in `isChunkLoadError`, preserves active drafts (`saveInteractionDraft`, `flushAutosaves`, `requestStorefrontPersistence`), and when controlled by a Service Worker (`navigator.serviceWorker.controller`), updates/waits for any installing worker and activates the waiting worker (`activateRegistrationUpdate`) before calling `window.location.reload()`.

## 6. Validation and status

- **Client unit tests (`client/src/lib/lazyWithRetry.test.ts`)**:
  - **Red**: Failed on unpatched `lazyWithRetry.ts` (cached sibling `QuranStationDrawer` clearing `Dashboard`'s reload guard, two uncached chunks `Login` + `QuranStationDrawer` failing across consecutive loads, `sessionStorage.setItem` throwing `QuotaExceededError`, Vite CSS preload error handling, and Service Worker update/activation before reload).
  - **Green**: 9/9 tests pass on patched `lazyWithRetry.ts` (single reload + second-failure throw, cached sibling `QuranStationDrawer` + failing `Dashboard` race, cross-hash recovery on reload, non-chunk error passthrough, >30s expired guard TTL after route redirect, multi-chunk `Login` + `QuranStationDrawer` consecutive-load failure, `sessionStorage.setItem` fail-closed handling, Vite CSS preload error recognition, and stale Service Worker update + activation before reload).
- **PWA build contract tests (`scripts/verify-storefront-pwa-build.test.mjs`)**:
  - **Red/Green**: 6/6 tests pass, verifying `assertStorefrontPrecacheNavigationPolicy` rejects default Workbox `PrecacheRoute` `directoryIndex` and accepts `directoryIndex: null` (both raw and Rollup-bundled).
- **Server, middleware & memory-budget unit tests**:
  - 45/45 Vitest unit tests pass across `client/src/lib/lazyWithRetry.test.ts` (9), `server/__tests__/staticAssets.test.ts` (5), `server/middleware/__tests__/runtimeStaticAssets.test.ts` (9), `server/middleware/__tests__/overloadGuard.test.ts` (11), `server/middleware/__tests__/requestPriority.test.ts` (10), and `server/lib/__tests__/webMemoryBudget.test.ts` (1).
- `pnpm check`: PASS (exit 0).
- `pnpm check:guards`: PASS (exit 0).
- `git diff --check`: PASS.

Production acceptance remains **PENDING**. No merge, no production deployment, and no financial data access were performed. Post-deployment acceptance requires a clean production observation window confirming `runtimeAssetMissCount = 0`, `lag503Count = 0`, and `http5xxCount = 0`.
