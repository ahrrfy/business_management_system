# Actual cash and credit returns laboratory

Isolated, synthetic extension of the existing credit Worker/D1 laboratory. No production application, database, DNS, Hostinger service or customer notification is changed. Existing lab identities, writer name, master fixtures, historical rows and signed journal prefix are retained.

The bundle calls the unchanged original ERP `createConfirmedPosSaleInTx`, `processPayment` and `returnSaleDirect` services, including original refund caps and full reversal logic. The adapter captures stock movements, receipts, customer AR/credit, simplified accounting entries, document effects, idempotency and the original execution audit action. A single D1 batch commits the complete staged effects. Success requires the separate signed journal acknowledgement. The restore Worker has only its own D1 binding.

Supported: ordinary stocked POS cash invoices (`PREPAID`) and credit invoices; unpaid, partly paid and fully collected credit; partial/full returns; restock or damaged disposition; CASH refund or retained registered-customer credit. A positive CASH refund requires an explicit actor-owned open drawer. Original permissions, period locks, refund authority, available cash, pending requests and remaining return quantities are checked again inside the actual service. A full return can create customer credit without a negative collectible invoice balance.

The lab rejects service, bundle, digital, consignment, backorder, delivery, work-order/deposit, coupon-redemption and installment dependencies, opening waivers, non-CASH refunds, and double-entry modes other than OFF. ACTIVE/SHADOW GL and approval-request execution are outside this proof. This is not the complete cashier/storefront migration. Returns accept at most two lines; cash sales retain the existing four-line input bound. Admission refuses more than30 changed rows,48 estimated SQL statements or the existing signed-page size limit before financial commit. Unsupported dependencies fail with422; authority refusals use412. No partial financial effects are left by those rejections.

The scoped read contains the whole target invoice/items, its ledger/receipts, customer open invoice headers, relevant drawer receipts and return-control dependencies. WAVG additionally reads all branch stocks for the returned variants. Unrelated historical invoices and global table scans are excluded. Decimal/text reductions replace the few exact original SUM/refund/document-effect expressions; unknown numeric SQL fails closed. The94 query shapes come from the real original MySQL service trace, not a wildcard allowlist.

Schema adds12 projection tables and return lookup indexes. Definitions of all35 existing tables remain identical, including old NULL-only dependency columns. The additive projection is also included in fresh offline recovery packages. Read-only generated control columns use an explicit allowlist; financial generated expressions remain guarded.

The flat RTL lab UI retains the complete immutable request, actor and key in the existing local storage slot before submission. An uncertain response locks creation of another command; reload, edits or a failed readiness check cannot replace its saved envelope. Reconciliation or an original-key replay resolves the command. Only a first definitive precommit rejection allows correction with a new key.

Confirmed retries use a read-only path when the UI sends `x-cash-retry: 1`. It verifies the immutable primary winner, complete signed ACK, request/plan/result hashes and guarded journal prefix without entering the financial writer queue. A missing winner or ACK goes through the original writer/recovery path; a corrupt ACK fails503 and retains the original request. The hint cannot authorize a financial write. Fresh commands keep their existing invocation budget; the separate frontend check uses6 queries, and a queued confirmed replay uses7. The conservative new-command admission estimate includes the added non-lookahead journal read.

Run focused tests from the repository root with the existing dependencies:

```powershell
node --test experiments/d1-continuity/returns/numeric.test.mjs experiments/d1-continuity/returns/policy.test.mjs experiments/d1-continuity/returns/recovery.test.mjs
node --import tsx --test experiments/d1-continuity/returns/query-plan.test.mjs experiments/d1-continuity/returns/performance.test.mjs experiments/d1-continuity/returns/ui.test.mjs experiments/d1-continuity/returns/parity.test.mjs
```

`oracle.mjs --verify-isolated-mysql` requires the private owned returns lab record and the fresh dedicated s5 oracle database on13326. Its guard verifies process, datadir, database names, port and UTC before resetting only that synthetic oracle database. Run with `node --import tsx`, then `node --test experiments/d1-continuity/returns/parity.test.mjs`. It never uses3306/3310. Eleven scenarios/34 commands compare13 financial tables, including decimal cents, both cash-rounding directions, discount allocation, historical WAVG and another branch. Only independent clocks are normalized.

`recovery.test.mjs` uses actual native workerd/D1 bindings, four cashier identities and two frontends. It injects journal failures, atomic last-statement failure, postcommit failure, response loss and a real Durable Object restart. It then disposes the source runtime and restores the signed checkpoint into an independent runtime; corrupt/out-of-order records are rejected and replay is inert. Unique result directories retain earlier signed exports. Hostinger unavailability is an outbound trap/no dependency; the production server is never stopped.

Cloud commands require the existing authenticated CLI4.151.1 and private local runtime files; no credentials belong here:

```powershell
node experiments/d1-continuity/returns/cloud-run.mjs --preflight --confirm-isolated-returns-lab
node experiments/d1-continuity/returns/cloud-run.mjs --extend --confirm-isolated-returns-lab
node experiments/d1-continuity/returns/cloud-run.mjs --deploy --confirm-isolated-returns-lab
node experiments/d1-continuity/returns/cloud-qualification.mjs --confirm-isolated-returns-lab
```

Preflight pins the existing account, database UUIDs/creation identities, Workers, legacy hashes and equal source/restore checkpoint. Extension creates only the12 missing empty projection tables and indexes; it neither resets nor updates existing financial rows. Deploy reuses the existing Workers, D1 bindings and Durable Object namespace; restore is deployed before primary. Never revert restore to the old schema after the first new return record. Retain the new recovery reader/schema when rolling back the writer or UI.

Cloud qualification uses the zero-balance customer1 and rejects existing open obligations; indebted customer5 and old invoices are preserved. Complete attempts are fsynced before submission. The bounded run measures12 sales,3 collections and24 returns with four cashiers, then fault recovery and full old/new-prefix restoration. It does not silently retry measurements. Read-only exports and restore may retry bounded transport/5xx failures with the same immutable record. A deterministic4xx stops immediately. Unknown outcomes retain the unique run folder; reconcile/resume its saved commands, never reset old debt or start a replacement run blindly.

No new paid service, D1 database, Worker or namespace is required. Cloud usage still consumes the existing account allowance; native timing does not predict deployed latency. Actual cloud results must be reported separately from native proof. Results, bundles, signed exports and private runtime files remain ignored; the dated result report records validation evidence and unresolved blockers.

For subsequent performance rounds on the retained financial baseline, use the guarded commands below. Do not repeat initial extension or reset customer balances. Deployment adds only the validated `accountingEntries(receiptId)` index when absent and checks that epochs/counts stay fixed. Qualification measures40 sales,10 collections and80 returns, with immediate confirmed retries and payload conflicts, using the same retry hint as the UI. It retains all earlier signed records and incrementally restores only records after the equal source/restore starting checkpoint. Fault checkpoints hash all financial tables and check command/outbox counts; final recovery compares the complete snapshot including command/plan bytes. Measurements have no hidden driver retries. A failed or unknown run must be reconciled from its retained attempt log before another run.

```powershell
node experiments/d1-continuity/returns/cloud-perf-deploy.mjs --confirm-isolated-returns-lab
node experiments/d1-continuity/returns/cloud-performance.mjs --confirm-isolated-returns-lab
```

If the original run completed export/restore but stopped during final assertions, `cloud-finalize.mjs --confirm-isolated-returns-lab qualification-<timestamp>` performs only read-only verification of that exact run. It requires all signed records to have successful original restore responses, checks HMAC and the pinned checkpoint, and preserves every historical financial row. The invoice counter must advance by the number of new invoices; the protocol epoch must advance to that signed checkpoint. Neither is an immutable historical financial record. This continuation never repeats a financial or restore command. A fresh qualification refuses a previously used return baseline; do not reset it to rerun measurements.
