# Conditional storefront runtime separation

Status: isolated implementation; legacy remains the default. No production activation, deployment, or capacity claim. The automatic deployment controller intentionally rejects split or mixed role inventories until a verified maintenance transition and rollback procedure exists. This is not an automatic production cutover implementation.

## Runtime contract

`WEB_RUNTIME_MODE=split` selects `erp-public` (one worker, loopback3001) and `erp-admin` (two workers, loopback3000) from the SAME immutable web artifact. `WEB_INSTANCES=3` is the GLOBAL count in both groups. `PUBLIC_WEB_INSTANCES` and `ADMIN_WEB_INSTANCES` must sum to it. The managed nginx contract uses fixed loopback ports; custom split PM2 ports fail closed.

`WEB_RUNTIME_ROLE=public` enforces the existing public API allowlist regardless of Host or forwarded headers and cannot run background jobs, including instance0. `admin` instance0 is the sole hub/job runner. Startup restore cleanup and product-channel self-healing now use that same runner gate. Public HTTP traffic returns503 while its bridge client is disconnected; it never becomes an isolated in-memory bus. Accepted requests drain before the bridge is closed.

Admin public procedures require the verified staff context, including storefront, public recruitment and branch selection. Public images, storefront SEO, shared wishlist links, sitemap and merchant feeds require staff on the admin listener. Auth entry/self-session routes retain their existing security policy. Authenticated staff preview and shared clients remain supported; public calls still consume public admission capacity. This is a process/request boundary, not database credential isolation.

## Checkout admission

Both `storefront.quoteOrder` and `storefront.quoteOrderPrivate` use the bounded public-order lane. The existing client already sends them through isolated `httpLink`. A batch mixing checkout operations with browsing or staff procedures is refused in enforce mode. Read and checkout active costs remain separately capped under the same total public cap; the default candidate checkout cost2 permits one quote/order auth+procedure peak at a time. No unrestricted priority path exists.

The existing queue total remains8 requests/24cost. Default read sublimits6requests/20cost leave room for checkout/staff. Individual timeouts and real-promise/tail settlement remain in force. `STOREFRONT_RESOURCE_MODE=observe` remains the default; enforce is an explicit laboratory candidate. These units are SQL fan-out admission estimates, not reserved MySQL connections or a throughput guarantee.

Split public PM2 workers explicitly receive `STOREFRONT_RESOURCE_WAIT_MS=900`. The loader-only `PUBLIC_STOREFRONT_RESOURCE_WAIT_MS` overrides it within 1..5000 ms and is validated only in split mode; invalid values fail split configuration. This public default/override wins over the generic `STOREFRONT_RESOURCE_WAIT_MS`, even when that generic value is 150. Admin and legacy keep their existing generic setting and 150 ms fallback. The loader exports only the effective public wait under the existing server key; the new upper bound belongs to this loader knob, not the server's generic parser.

The finite 900 ms buffer follows the cache-enabled isolated trace: successful browse P99 was 713.18 ms, and a checkout held its cost2 lane for about 315 ms while a queued quote expired under the former 150 ms deadline before any SQL acquisition. It trades bounded queue latency for fewer retries/errors; it does not establish traffic capacity. Active caps 18 total/14 public/12 read/2 order, queue counts/costs, priorities, SQL pools and worker counts remain unchanged. Shutdown still rejects queued admissions immediately; the wait adds nothing to the existing graceful shutdown deadline. A separate isolated run must measure this different wait policy before any availability conclusion.

## Connection budget

Split requires explicit `DB_WEB_CONNECTION_BUDGET` and `DB_AUX_CONNECTION_BUDGET`. Role pool limits are `PUBLIC_DB_POOL_LIMIT` and `ADMIN_DB_POOL_LIMIT`, falling back to `DB_POOL_LIMIT`. The global formula is:

`[(publicWorkers × publicPool + adminWorkers × adminPool + extraWorkers × max(rolePools)) × poolsPerWorker] + [(globalWorkers + extraWorkers) × controlPool] + auxiliary`

Single tenancy uses one application pool per worker. Multitenancy multiplies by `DB_MAX_TENANT_POOLS_PER_WORKER` and includes each process control pool. Web terms must fit the explicit web budget; the complete sum must fit `MYSQL_MAX_CONNECTIONS − DB_CONNECTION_RESERVE`. `DB_RUNTIME_EXTRA_WORKERS=0` does not authorize a rolling reload. Any transient/compatibility worker requires both connection and measured CPU/RAM headroom.

Admin jobs reuse its application/control pools. Auxiliary inventory is deployment-specific: the independently released HR bridge has its OWN application pool (`DB_POOL_LIMIT`, default10) and can inherit a control database; a conservative multitenant ceiling also includes its own default5 tenant pools and control5. The provision worker serially executes control steps (default5), root SQL commands (one connection), and seed/migration subprocesses (seed application default10); those phases must not be counted as free simply because they are short-lived. Inspect actual bridge release environment, enabled provision policy and any other maintenance client before setting auxiliary. Laboratory auxiliary0 is valid only because no auxiliary worker runs. Diagnostic generator uses an additional single connection equally in both modes, reported separately.

## Managed routing and rollback prerequisite

The immutable nginx manifest authenticates SOURCE templates before rendering. The renderer can only choose legacy3000 or public3001/admin3000. Captured hashes of verified STAGED rendered bytes are used for final validation, so a later source-file replacement cannot change the installed expectation. Existing atomic staging, nginx validation, smoke checks, backup and rollback remain active. Secrets, CSP and API allowlists are preserved.

Production transition is deliberately blocked in `scripts/deploy.mjs` before recovery/mutation, and again before reload, if config or PM2 inventory contains split roles (even renamed processes). Legacy deployment remains unchanged. A future approved activation must satisfy exact-head CI/security gates, measured host/SQL/headroom evidence, no unexpected worker inventory, shared database/artifact identity and tested recovery. Use the existing root-owned managed nginx installer; no hand-edited nginx copies.

Maintenance sequence to validate before activation: stop admission/drain old HTTP requests; stop the old group and verify sockets/processes gone before starting replacement workers when no overlap budget exists; start admin hub then public clients; verify all3 fresh identities, role boundaries, DB health, staff login, quotation/create/replay, event delivery and PWA barrier; only then commit managed routing. A failed transition must drain replacement workers, restore the previous artifact/config/group and managed routing without recreating orders or database writes. Keep enough interruption budget for the maintenance gap. Neither this document nor a PM2 memory-restart threshold proves hard memory isolation or grants approval to perform it.

## Laboratory limits

New matched comparison: unified3×pool4 versus public1×pool2/admin2×pool5; same aggregate12 web connections, three0.5CPU/512MiB workers, shared MySQL1CPU/2048MiB/maxconn64 and bounded0.5CPU/256MiB generator. This differs from the historical single-worker10 profile and is not a causal before/after comparison with it.

`storefront-runtime-lab.mjs` requires the exact dedicated33324 fixture schema and NODE_ENV=test. Worker loads the actual compiled HTTP entrypoint and substitutes ONLY local synthetic Siteverify success; all other external fetch is forbidden. Test bootstrap suppresses some background schedules. Plain Node records source-map state and does not represent PM2 daemon/source-map-support overhead;512MiB is not a verified production PM2 envelope.

Probe covers actual staff request, global membership and PWA quiesce. Measurement records quiet/mixed staff latency, browsing, both quotations, create/replay, payload rejection, response-body loss recovery, unchanged financial/physical-stock counts, PENDING orders and admin SSE delivery. Last-unit POS coverage is an actual POS READ alongside quotation; committed POS sale contention is not claimed. Precommit transport loss is cancelled before sending; midtransaction interruption is not claimed. Results may fail the20%staff degradation or quote-availability target and must remain reported as failures. No reruns solely to find favorable noise.

## Correction-wave lifecycle and evidence contract

Database policy treats an absent WEB_RUNTIME_ROLE under split as an auxiliary CLI context only; HTTP bootstrap still requires explicit public/admin. Its actual DB_POOL_LIMIT times tenant-pool ceiling plus control pool must fit the declared auxiliary allowance before pool creation. This is a per-process ceiling check, not verification of simultaneous auxiliary inventory. Provision-worker children already use positive environment allowlists and dotenv isolation; that legacy policy is preserved.

Shutdown closes admission/listeners and stops scheduled sources before awaiting actual context, tenancy, procedure, handler, background and registered tail promises. The private print status/raw/test handlers track their actual authorization, sender and audit promises, independently of tenancy's Express next(). Accepted active roots may start descendants after drain begins. Client disconnection does not release those scopes. Bridge hello frames advertise drain-ACK capability. Split always requires a connected peer to acknowledge an ordered marker after preceding event frames, before bridge/pool teardown. Legacy peers without that capability retain best-effort behavior through a flushed TCP close handshake; this is not delivery confirmation. A peer advertising ACK support cannot silently downgrade after an ACK timeout. The existing 10-second shutdown deadline exits nonzero if work or bridge drain cannot complete; it never reports graceful success or explicitly closes pools first in that case. PM2 kill_timeout remains11seconds. Hard kills, power loss, provider behavior and delivery across network outages are not guaranteed. The control is lifecycle tracking, not a new job framework or a change to transaction retries.

Deployment validation uses dotenv's parser and the same inherited-environment precedence as ecosystem evaluation, including ambient split/role values, before mutable deployment steps. Automatic split activation is still blocked.

Lab financial snapshots include accountingEntries and journalEntries. Changed-payload success requires HTTP409/CONFLICT and byte-equivalent original persisted order/item snapshots with the original request key/address. Overload, timeouts and transport failures are failed evidence. Fixture seeding upserts only the migrated store-settings singleton, requires clean fixture tables, and commits its inserts in one transaction; an incomplete/occupied fixture requires the dedicated guarded reset, not a blind rerun.
