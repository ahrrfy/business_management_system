# Original MySQL accounting oracle (Q1)

An isolated qualification harness. It calls the unchanged `createConfirmedPosSale`, `processPayment`, and `returnSaleDirect`; no posting, sales, or return logic is copied. The source modules and schema are SHA-256 recorded in each evidence file.

Run from the repository root with existing dependencies:

```powershell
node --import tsx experiments/d1-continuity/accounting/oracle.mjs --verify-isolated-mysql
node experiments/d1-continuity/accounting/validate.mjs
node --test experiments/d1-continuity/accounting/guard.test.mjs
```

The existing private synthetic WSL MySQL 8.4.11 server on port 13326 must be running. The original guard verifies its live process record, datadir, version and UTC offset; the harness asserts the exact `erp_d1_returns_actual_20261019_s5_test` schema before resets. Only that dedicated schema is truncated. No installer, production host, cloud resource, port 3306 or port 3310 is used. A schema-specific advisory lock serializes accounting harness runs. Other programs using s5 must remain idle.

Default private runtime and generated fixture paths are under the parent continuity lab worktree. `ACCOUNTING_ORACLE_RUNTIME` and `ACCOUNTING_ORACLE_FIXTURE` can locate copies; runtime values must still pass the fixed server/schema guard. The fixture itself is copied into ignored `accounting/results/fixture.sql`. Never point another oracle at s5 during a run.

The matrix contains four ACTIVE sale refusals (policy hash, cycle, opening hash, required AR map), one intentional SHADOW mapping gap, six normal SHADOW/ACTIVE cash and credit workflows, and two ACTIVE faults applied after a valid sale to test collection and return rollback. Normal sale quantity is 3 at 83.37 IQD with 41.68 base cost: total 250.11, cost 125.04. Partial/full returns are 1 + 2; cash refunds are 83.37 + 166.74. Credit collection is 100.05 at sale plus 150.06 subsequently. Each successful keyed mutation is replayed; changed sale/return/collection payloads are checked. SHADOW must retain operational effects and a visible UNMAPPED gap when statutory mapping is missing.

`--failure-followups` runs only the two post-sale fault scenarios for focused repair; it writes distinct `*-followups.json` evidence. A complete canonical run uses the first command above.

All generated output stays in ignored `results/`: `mysql-oracle.json` contains commands, actor, original service results/errors, complete before/after financial and policy rows, parameterized SQL traces, journal totals, source hashes and fixture hash. `sql-shapes.json` admits exact normalized original-service SQL shapes, including locks/transactions. `summary.json` records counts and table set. Setup queries are excluded from command SQL shapes. Money remains decimal strings and validation uses Decimal, never floating-point conversion.

When a prior completed run is saved as `results/baseline-mysql-oracle.json`, `node experiments/d1-continuity/accounting/repeatability.mjs` compares its full command results, rows and SQL traces with the current run. It normalizes only timestamp scalar strings and requires identical original source hashes. It performs no database calls.

For the later D1 adapter, the input boundary is the three original service payloads plus `Actor`; the output boundary is the original result/error and the persisted row graph. Preserve postingIntentJson/hash/cycle/profile, journal entry/line account and statutory snapshots, receipt direction/bucket, source links, counters, idempotency, inventory valuation and all documentEffects. Map MySQL transactions/locking to an atomic guarded D1 commit, and preserve rejection without residual effects. Compare clocks separately; generated timestamps are evidence, not stable business input. The ledger total for a fully returned unpaid credit sale is 750.30 on each side; cash or fully collected/refunded credit totals 1250.52 on each side.

Limits: this does not authorize ACTIVE activation, implement a D1 port, or prove reporting/UI/router authorization. The runtime policy fixture follows the original `shadowHook.test.ts` contract, and the statutory profile is seeded/approved through original services. Synthetic approval is test setup, not evidence that the production activation governance gate was exercised. `returnSaleDirect` itself does not write the caller's user audit entry; the router/owner wrapper must retain that separate contract. No replacement audit is fabricated here. Customers have no phone, no WhatsApp integration or outbox is seeded, and fetch is blocked. No realtime listener/provider is started, and provider delivery is not qualified.

## Native Q1B qualification

The isolated native worker calls the same original services through the established private staged adapter. `accounting/actual.ts` supplies an immutable per-port schema, exact traced SQL allowlist, scoped source/journal projection, supported modes and mutable-table set to `createReturnsPort`. Existing OFF callers keep their defaults. Accounts and statutory policy are captured with the invoice financial history under one epoch; Decimal values stay text.

```powershell
node --import tsx --test experiments/d1-continuity/accounting/native.test.mjs
node --import tsx --test experiments/d1-continuity/accounting/recovery.test.mjs
node --import tsx experiments/d1-continuity/accounting/oracle.mjs --verify-isolated-mysql --larger-only
node --import tsx --test experiments/d1-continuity/accounting/budget.test.mjs
node --test experiments/d1-continuity/accounting/port.test.mjs
```

Native tests require the unchanged reviewed `accounting/results/mysql-oracle.json` and its existing experiment/cash dependencies; no install or cloud resource is needed. Larger evidence writes only `results/larger/`, preserving the canonical Q1A result. The four-line case needs no new SQL shapes. Tests create independent Miniflare/workerd D1 bindings and block/record outbound attempts.

Wire translation is explicit in `native-support.mjs`: original PREPAID `SALE` becomes `CASH_SALE`, original CREDIT remains `SALE`, and collection/return receive the lab branch/drawer envelope. Only transport fields are removed/reintroduced by the existing caller wrapper; original service payload semantics remain unchanged. Responses add the existing recovery metadata. Confirmed replay returns the original acknowledged success (including its original optional result fields); the original MySQL service's sale replay has a smaller result shape. Payload/actor conflicts retain the recovery protocol's409 error rather than re-running the service.

Financial parity compares all21 projected tables in the Q1A23-table row graph, including complete journals, statutory snapshots, IDs, amounts, source references and hashes. Only independent timestamp scalars are normalized; DATE columns are compared as exact ISO calendar dates after driver encoding conversion. JSON arrays retain order. `auditLogs` is verified separately by executing the original `logAuditTx` against a capturing transaction and comparing all written fields; a confirmed key writes it once. `waOutbox` is not projected: customers have no phone and the worker records zero external attempts. This is not a claim of identical audit/outbox tables or provider delivery.

Default native admission keeps30 changed rows and the conservative48-statement limit, with adjacent same-table inserts grouped below100 binds. The larger original invoice's final return needs33 rows, so the default rejects atomically. `candidate.ts` is an explicit native-only64-row configuration with a distinct schema version; it completes that case at36 actual SQL statements and passes signed cold restore. It does not change existing OFF/cloud identity, writer name, row limits or production behavior.

All generated row graphs, measurements, signed journals and source hashes remain ignored under `results/` and `build/`. This qualification does not authorize real ACTIVE activation or qualify cashier/storefront completeness, accountant governance, provider delivery, cloud D1 CPU/latency or production limits.

## Local Q1C namespace proof

`buildAccountingWorker({ namespace: true })` explicitly selects the fixed `q1gl_` object namespace and `actual-accounting-q1-namespace` signed lab identity. The default build keeps its prior identity and30-row admission. The optional candidate still has a separate64-row schema identity. A namespace wrapper covers both front-end confirmed replay and the sole writer's D1 environment; it preserves native sessions, bookmarks, batches, statement results and bind values. Signed plans and snapshot graphs retain logical table names. The stable writer name remains `<LAB_ID>:primary:writer-v1`.

Only known table/index/trigger identifiers are mapped. Business strings/comments remain byte-for-byte intact. The six journal guard names inside the exact `sqlite_master` predicate and the scoped `sqlite_sequence` name predicates are explicitly qualified; unsupported metadata/PRAGMA/DDL and malformed lexical forms fail closed. This is a bounded adapter for the existing experiment SQL, not a general SQLite rewriter. Accounting initialization now preserves the inherited14 read indexes and adds its four accounting indexes.

```powershell
$env:ACCOUNTING_NAMESPACE='1'
node --import tsx --test --test-concurrency=1 experiments/d1-continuity/accounting/native.test.mjs experiments/d1-continuity/accounting/recovery.test.mjs experiments/d1-continuity/accounting/budget.test.mjs experiments/d1-continuity/accounting/admission.test.mjs experiments/d1-continuity/accounting/namespace-guard.test.mjs
node --import tsx --test experiments/d1-continuity/accounting/namespace.test.mjs experiments/d1-continuity/accounting/indexes.test.mjs
```

Each namespaced native lab first creates a complete bare Q1B schema, executes a genuine old cash sale and replays its signed record into the bare restore schema. New objects initialize additively beside that history. Full bare DDL and every row (including bare sequence values) are hashed before and after initialization, commands, faults and cold restore. The guard test drops exactly one new journal trigger while retaining all six legacy guards, proves inert refusal, and rejects the genuine old signed record in the new restore lab. Primary, journal and restore remain three separate physical native D1 databases.

Evidence is isolated in ignored `results/namespace/` and `build/namespace-*/`. Optional default regression evidence uses `ACCOUNTING_RESULTS_SCOPE=namespace-default` to avoid overwriting Q1A/B artifacts. Native page measurements enforce131072 bytes, statements keep the48/Free50 gate, and the namespace binding refuses more than100 binds. No cloud script/resource, real activation, provider transaction or production setting changes here. Native timing cannot establish cloud P95/CPU acceptance; growing history still needs measured cloud row-read/page budgets.
