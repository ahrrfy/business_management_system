# Actual cash-sale continuity laboratory

This isolated experiment runs the original `createConfirmedPosSaleInTx` → `createSaleInTx` financial path inside Workers. It imports the original inventory, billing, money, numbering, ledger, attribution, idempotency and financial posting gates. It does not call Hostinger or use the earlier synthetic `commands.mjs` sale model.

The admitted scope is full CASH, POS, ordinary owned stocked products, at most four lines, an existing open synthetic cashier shift, no customer account, and the original double-entry setting OFF. Credit, returns, digital cards, services, bundles, consignment, delivery, provider payments, production authentication and a production POS interface are outside this stage. Unknown options/SQL fail closed. The small Arabic test console uses a separate test token and fixed synthetic actor. No production routes, data, DNS, credentials or services are changed.

## Transaction strategy

The primary Worker admits `/sale` through one stable SQLite-backed Durable Object name for the whole primary database. Its FIFO queue holds at most eight running/waiting operations, including the independent journal acknowledgement. It has no timeout-based lock release or direct-write fallback. A reset loses only volatile admission state: saved original requests must be replayed, while D1 epoch/preimage assertions, unique keys and signed journal checks remain the durable guards. FIFO starts at admission after request validation, not at global HTTP arrival.

1. Read the finite D1 state and its command epoch in one authoritative primary SQL statement.
2. Run the original service against a private SQLite WASM staging database. A reviewed finite MySQL SQL allowlist translates only necessary dialect operations; all money calculations stay in original Decimal functions. Preserve defaults, original sequence values, returned IDs, read-after-write and MySQL automatic update timestamps.
3. Build exact row preimages/afterimages. One native D1 batch asserts the epoch and applies all financial rows, original idempotency, saved command/result and durable outbox together. A failed assertion or final statement rolls everything back. Every permitted fixture writer advances the epoch. Removing that ownership rule invalidates the concurrency proof.
4. Store each prepared plan in a separate immutable recovery D1 database before applying it. Read the winning primary command after a competing commit. Confirm its exact plan in the independent journal before returning success. The journal must have a contiguous prefix from fixture epoch 1 through the winning sale epoch; its committed INSERT atomically permits only the next epoch. Before a new sale, repair at most one oldest missing winner from exact matching primary command/outbox bytes, then return `RECOVERY_PREFIX_PENDING_RETRY_SAME_REQUEST` (409) for another invocation with the identical saved input/ID. Prepared attempts are never commit evidence; existing-winner retries acknowledge only when their own epoch is durable. Invalid journal prefixes also refuse export. A lost response or copy pending state requires the same original request ID and payload.
5. Export signed committed plans to an external file with `fsync`. A separate restore Worker, with only its fresh target DB binding, replays the file one complete sale per HTTP request. Each sale is atomic and replayable; the whole file is resumable across requests. HMAC, epoch, row preimages, constraints and original saved command prevent silent tampering, gaps and duplicate effects.

The primary/journal D1 databases are logically independent but share Cloudflare. The external file proves recovery at its recorded export checkpoint; it is not continuous off-provider acknowledgement. The in-memory finite snapshot approach is a bounded compatibility proof and needs a narrower scalable repository/command port before production volume. It is not a generic MySQL driver or a complete ERP migration.

## Local execution

Use the existing root dependencies and install only the pinned SQL.js experiment dependency under this folder:

```powershell
npm ci --prefix experiments/d1-continuity/cash --ignore-scripts --no-audit --no-fund
node experiments/d1-continuity/cash/core.test.mjs
node --test experiments/d1-continuity/cash/cloud-client.test.mjs experiments/d1-continuity/cash/retry-policy.test.mjs experiments/d1-continuity/cash/http-input.test.mjs experiments/d1-continuity/cash/writer-queue.test.mjs
node --test experiments/d1-continuity/cash/integration.test.mjs experiments/d1-continuity/cash/writer.integration.test.mjs
```

Snapshot JSON construction uses at most 15 column/value pairs per function (30 `json_object` / 31 `json_set` arguments), within the [documented D1 32-argument limit](https://developers.cloudflare.com/d1/platform/limits/). Every unsuccessful SQLite snapshot allocation is closed, and successful close is idempotent. Focused tests include 12 repeated post-allocation decimal/constraint/cap failures and count actual function arguments.

The tests use real workerd and D1, synthetic fixtures and a denied outbound service. They never stop the production Hostinger server. Build provenance lists original source hashes and substitutions. Notifications/realtime transports throw if invoked; the durable financial outbox is saved atomically and external delivery is not claimed.

`mysql-lab.mjs` is a separate Windows MySQL reference harness. It pins loopback13318, a fresh TEMP datadir, the previously downloaded official8.4.9 binary and a test-only database, verifying process/listener and actual server identity before mutating SQL. It never accepts an arbitrary URL. Its full test-suite cleanup is destructive only inside that dedicated lab. A documented lab-only metadata collation compatibility step completes migration0363 on Windows; original migration files remain unchanged.

The complete ERP suite uses the fixed `erp_d1_actual_cash_20261017_test` database. The original-service oracle uses the separate fixed `erp_d1_actual_cash_20261017_oracle_test` database on that same verified child, so its reset cannot race the suite cleanup. Initialize it explicitly with `mysql-lab.mjs --init-oracle` and, on the recorded Windows metadata-collation failure, `--complete-windows-oracle-init`; then run `node --import tsx experiments/d1-continuity/cash/oracle.mjs --verify-isolated-mysql` and `node --test experiments/d1-continuity/cash/oracle-parity.test.mjs`. Both the server and reference driver use UTC. Parity compares exact financial values/IDs/links/JSON; independent command clocks are compared by UTC day and fixture-vs-command timestamp classification, not exact subsecond equality.

## Cloud execution

`cloud-run.mjs` pins three specific test DB identities and two test Workers. It refuses nonempty initialization and disables Wrangler disk logs/metrics. Runtime descriptors and test tokens are kept in ignored session scratch. No paid upgrade is performed.

```powershell
node experiments/d1-continuity/cash/build.mjs
node experiments/d1-continuity/cash/cloud-run.mjs --initialize --confirm-isolated-cash-lab
node experiments/d1-continuity/cash/cloud-run.mjs --deploy --confirm-isolated-cash-lab
node experiments/d1-continuity/cash/load.mjs --confirm-isolated-cash-lab
```

Do not rerun initialization on retained evidence resources. The cloud test is capped at160 HTTP requests; load is intentionally short and bounded. It uses retained SKU2 and refuses to start unless its existing stock covers the entire trial; it never replenishes or resets history. Retries keep the identical saved command and use only identified transport, stale-epoch or prefix-pending codes. Generic business errors, Worker1102 and queue overflow never become automatic financial retry loops. The local instrumented four-distinct-line rounded sale uses at most42 D1 statements; repair invocations do not also execute a new sale. Native workerd tests cover two frontends sharing one writer, FIFO admission, overflow, a real object reset after primary commit, and full recovery after disposing the source. Raw measurements, source/bundle hashes and external export paths are stored under ignored `results/`; the latest durable report is `docs/superpowers/plans/2026-10-18-d1-cash-fair-writer-results.md`.
