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
