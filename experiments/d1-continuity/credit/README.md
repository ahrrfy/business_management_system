# Actual credit POS laboratory

Isolated, synthetic experiment. Production application files, routes, data and authentication are unchanged.

The Worker bundles original ERP sale, credit policy, contract pricing, inventory, FIFO auto-settlement, collection and simplified accounting services. A private SQLite staging transaction captures their exact SQL effects. One shared Durable Object serializes both sale and collection; a native D1 batch commits their financial effects, command result and outbox atomically. An independent D1 journal must acknowledge the signed record before success. The restore Worker has neither source/journal nor writer bindings.

Supported: ordinary stocked POS credit sale for a customer, optional initial CASH payment, subsequent partial/final CASH collection, exact original credit limits/contracts/FIFO and stable command replay after later collections. Complete customer open-invoice headers are read across branches; unrelated historical invoices/receipts/ledger rows are excluded. Money remains Decimal/text. The original customer increment is translated to exact Decimal addition; MySQL customer update timestamps are retained. This is a lab adapter, not a complete MySQL-to-D1 migration.

Rejected explicitly: customer/target delivery histories, non-POS/non-credit/non-stocked collection targets, services/bundles/digital cards/consignment/backorder sales, internal approval bypasses, active opening waivers, non-CASH collections, and double-entry modes other than OFF. The original simplified SALE/PAYMENT_IN ledger is supported; ACTIVE/SHADOW GL posting is outside this proof. Post-commit hooks are deferred into the financial outbox, not sent to real users.

Every command keeps the full saved payload, actor and request key (8–50 characters). A lost reply is reconciled or retried using that same key. PREPARED is not proof of financial commit; unacknowledged operations are not reported as success. Changing any payload or actor under a reserved key conflicts.

The successful protocol reserves12 SQL statements outside the atomic financial batch and5 inside it, plus1 per insert/2 per update. Admission rejects more than48 estimated statements or30 changed rows before PREPARED/primary commit, rather than splitting FIFO allocation. The future signed record and exact escaped command/outbox rows must each fit a128KiB recovery page. Oversized closures return422 without financial changes. These safeguards preserve the current low-cost invocation bounds; they are not an unlimited-history performance claim.

The ordinary credit path uses5 database RPCs in4 sequential network stages: parallel read-only identity/preflight batches, one conditional reservation/PREPARED batch, the atomic financial batch, and the independent journal acknowledgement. The primary preflight captures the required projection in its native batch; the snapshot is bound to the exact envelope, epoch and date boundaries for that invocation only. Existing-command replay skips the mutable projection. Financial preimages and epoch CAS still reject a superseded snapshot. Cash callers retain their original default protocol.

Staging has no financial or external effects. A caught business/admission error reserves the immutable request before returning its error; a process killed before that reservation leaves no durable reservation or financial effects. Clients must preserve and retry their original envelope/key in either case. A lost merged-batch response never permits a primary commit in that invocation. Success still waits for independent signed journal acknowledgement while holding the shared writer queue.

Run from the repository root with the existing dependencies:

```powershell
node --test --test-concurrency=1 experiments/d1-continuity/credit/core.test.mjs experiments/d1-continuity/credit/policy.test.mjs experiments/d1-continuity/credit/admission.test.mjs experiments/d1-continuity/credit/performance.test.mjs experiments/d1-continuity/credit/recovery.integration.test.mjs
node experiments/d1-continuity/credit/cloud-run.mjs --build
```

`oracle.mjs --verify-isolated-mysql` additionally requires the verified owned WSL MySQL13323 record and a freshly initialized dedicated s5 oracle database. Its guard checks the exact process/datadir/port before resetting that synthetic oracle database. It never uses3306/3310. Run it with `node --import tsx`, then `node --test experiments/d1-continuity/credit/parity.test.mjs`. The oracle compares11 financial tables for7 scenarios/12 commands; only independent execution clocks are normalized.

Cloud operations require an existing authenticated CLI4.151.1 and private local lab runtime/secret files. No credentials belong in this folder. `cloud-run.mjs --preflight|--initialize|--deploy|--verify-legacy --confirm-isolated-credit-lab` pins the exact account, reused database UUIDs, creation identities and additive table boundaries. Initialization refuses an unknown previous import result; inspect and verify it before any continuation. No production routes, DNS, new D1 database or subscription upgrade is configured.

`cloud-proof.mjs --confirm-isolated-credit-lab` saves full envelopes before submission, runs a small financial/fault/replay load, exports a pinned signed checkpoint, blocks source access in its driver, restores without a journal binding and compares every row. Native recovery additionally disposes the actual source runtime and aborts a real Durable Object after a collection commit. Do not rerun cloud trials just to refresh documentation; retain their evidence under ignored `results/`.

For the performance qualification, `performance.mjs baseline|after|single --confirm-isolated-credit-lab` saves commands before submission and records separate end-to-end, writer, queue and database measurements. Baseline/after use16 sales and32 collections at concurrency4; single uses8/16 at concurrency1 after a status request. These are bounded cloud samples, not a sustained capacity guarantee. The load driver does not automatically retry financial transport failures. Native `CREDIT_LOAD_SALES=1000` runs1000 sales and2000 collections plus fault scenarios. `performance-recovery.mjs --confirm-isolated-credit-lab` retains and verifies the existing cloud restore prefix, replays the complete signed journal and compares every financial row without resetting either database. Its source outage is enforced by the test driver; it does not physically stop Hostinger or the cloud Worker.

See the dated design, execution plan and results report in `docs/superpowers/`. Production readiness requires the remaining broader cash register functions, real authentication, operational fencing, notification delivery, larger customer-history/performance qualification and explicit production authorization.
