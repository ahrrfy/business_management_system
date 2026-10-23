# Delivery and aftercare implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Track completion in this file. The user approved the complete design and autonomous execution on 2026-10-23; do not ask for another design approval.

**Goal:** Complete prepaid delivery, unified preparation/shipping, classified extra charges and aftercare without duplicate sales, collection or inventory consumption.

**Architecture:** Extend existing financial writers and shipment services. Add bounded fulfillment documents and their typed source links; retain original invoices, receipts, shifts and bundle snapshots. Keep financial claims distinct from references to historical sales.

**Tech Stack:** Existing React/tRPC/Drizzle/MySQL/decimal.js stack, Node 24.22.1, no new dependencies.

## Global constraints

- Approved specification: `docs/superpowers/specs/2026-10-23-delivery-aftercare-design.md`, all 22 acceptance rows.
- Worktree: `D:/business_management_system-worktrees/delivery-aftercare-design-20261023`; no edits on main or another live owner's files.
- User requests simple traditional flat RTL UI, strict backend, complete connected effects and economical execution.
- Money uses decimal.js; quantities use base units. Cash alone touches DRAWER/TREASURY; external proof is consumed once. No financial fake products or invoices.
- Main coordinator owns schema integration/migrations/routes/navigation after explicit handoff by the current integration owner. Other workers edit disjoint claimed files only. No worker commits, merges, migrates a database or runs database suites concurrently; coordinator runs shared gates once per integrated head.
- Each mutation verifies branch, operation permission, current version, source ownership and request fingerprint under `withTx`; same-key changed-payload reuse rejects.
- Existing CLOSED/CANCELLED/SUPERSEDED/RETURNED financial contracts and original receipt allocation rules remain effective.
- Qualified prototype names below are binding interfaces; table columns are frozen in `drizzle/fulfillmentSchema.ts` before dependent writers start. Workers import those definitions directly until the coordinator exports them from root schema.

## Task 1: Actual payment rail for held delivery fees

**Files:** `server/services/delivery/feeHeld.ts`, `server/services/delivery/posting.ts`, `server/services/sale/create.ts`, `server/services/sale/types.ts`, `server/services/posExternalPayment.ts`, `server/services/receptionCheckoutService.ts`, `server/services/reception/commit.ts`, `server/services/workOrder/create.ts`, related router input contracts and focused tests. UI adapters are integrated in task 6 after ownership handoff.

**Interfaces:** Add a typed optional delivery-fee tender, defaulting to CASH only for backward-compatible omitted legacy input. Every explicitly selected rail persists the actual method/reference and bucket. A confirmed combined external payment covers goods plus fee exactly once; sale allocations exclude the fee from invoice.paidAmount. Keep a separately confirmed tender available for different goods/fee rails. Existing `recordDeliveryFeeHeldInTx` remains the single writer for invoice-held fees; share its posting construction with work-order-held fees.

- [x] Write integration regressions: goods 50,000 + fee 5,000 CARD -> 55,000 noncash, invoice paid 50,000, held 5,000, drawer delta 0; CASH variant -> drawer 55,000 before any actual payout; same-key replay -> no extra writes. Cover mixed goods/fee rails and rejected/reused external proof.
- [x] Implement fee method/reference validation and shared writer; expand confirmed amount binding without allowing proof reuse by allocations.
- [x] Update reception direct/draft and work-order entry points, cancellation/refund handling and truthful receipt fields. A database rollback must preserve the already confirmed external attempt for recovery.
- [x] Run the covering integration tests on the coordinator's isolated database, then inspect the diff for unmodified affected entry points.

```ts
expect(invoice.paidAmount).toBe("50000.00");
expect(feeReceipt.paymentMethod).toBe("CARD");
expect(feeReceipt.cashBucket).toBeNull();
expect(feeReceipt.amount).toBe("5000.00");
expect(replayed.invoiceId).toBe(invoice.id);
```

## Task 2: Persisted fulfillment contracts and transaction guards

**Create:** `drizzle/fulfillmentSchema.ts`, `shared/fulfillment.ts`, `server/services/fulfillment/core.ts`, `server/services/fulfillment/posting.ts`. **Integrate:** root schema, a reserved migration and journal, posting profiles, migration/check registration after handoff.

Tables: `fulfillmentRequests`, `fulfillmentRequestItems`, `fulfillmentCharges`, `fulfillmentChargePayments`, `aftercareCases`, `aftercareLines`, `aftercareExecutions`, `aftercareExecutionLines`. They reference real branches/customers/invoices/work-orders/receipts/variants/actors. Sources are mutually exclusive and active source ownership is unique. Request/case version and request-key/hash columns protect transitions and retries.

Shared `FulfillmentMutationIdentity = { clientRequestId: string; expectedVersion: number }`. `fulfillmentError(why)` returns an actionable Arabic TRPCError. `assertFulfillmentBranch(actor, branchId)` uses existing branch authority. `fulfillmentFingerprint(value)` uses canonical JSON and SHA-256. `loadFulfillmentRequestTx(tx,id,actor,{lock:true})` and equivalent case loader read current rows and assert scope. Wrappers use existing operation gates; no role-only authorization shortcut.

- [x] Create constrained models and shared literal labels/types.
- [x] Add financial posting helpers with independent source components. SERVICE/OUTSOURCED recognize customer claim/revenue, PASS_THROUGH claim/liability, SHOP_EXPENSE cost/liability. Extra charges never inflate invoice totals or goods commission.
- [x] Reserve migration atomically above fresh main; export new schema, enforce foreign keys/checks and test the actual SQL on an isolated database.
- [x] Test source XOR, money/quantity checks, uniqueness, branch denial and request-fingerprint conflict.

## Task 3: Preparation request and atomic multi-source release

**Create:** `server/services/fulfillment/requests.ts`, `server/services/fulfillment/requestQueries.ts`, `server/services/__tests__/fulfillmentRequests.test.ts`. Existing shipment/dispatch integration is changed only after its live owner releases it.

**Interfaces:** Export `createFulfillmentRequest(input, actor)`, `updateFulfillmentRequest(input, actor)`, `releaseFulfillmentRequest(input, actor)`, `cancelFulfillmentRequest(input, actor)`, `listFulfillmentRequests(input, actor)`, `getFulfillmentRequest(id, actor)`. Input sources are `{invoiceId}` or `{workOrderId}`; create also takes recipient/party/fee fields and clientRequestId. Transitions take id and shared mutation identity. Detail returns request/items, invoice links, readiness, charges, shipping/custody and current monetary totals.

- [x] Prove two cashiers' paid invoices produce one shipment/fee without invoices/receipts added; include a ready work order not yet invoiced, and a not-ready order which prevents release by default.
- [x] Lock request and source documents in stable order; verify customer/normalized phone, branch, source eligibility and current remaining amounts. Track active source ownership and reject another active request.
- [x] Materialize a ready work-order invoice through its existing service once, preserve deposits and original attribution, then call existing shipment dispatch in the same transaction. Do not call a wrapper which opens a second independent transaction.
- [x] Support explicit partial release with exact remaining items and a visible future-fee decision; cancellation releases only active preparation links and reverses only real shipping effects.
- [ ] Run focused request, existing multi-invoice and shipment operation tests once integrated.

## Task 4: Classified charges, claims, collections and outsourcing costs

**Create:** `server/services/fulfillment/charges.ts`, `server/services/fulfillment/chargeQueries.ts`, `server/services/__tests__/fulfillmentCharges.test.ts`. **Modify after coordinator allocation:** customer-statement/aging and financial report readers needed for these claims, source mapping and shipment claim allocations.

**Interfaces:** `createFulfillmentCharge(input,actor)`, `approveFulfillmentCharge(input,actor)`, `collectFulfillmentCharges(input,actor)`, `refundFulfillmentCharge(input,actor)`, `settleFulfillmentChargePayee(input,actor)`, `listFulfillmentCharges(input,actor)`. Persist categories SERVICE/OUTSOURCED/PASS_THROUGH/SHOP_EXPENSE, description, customer amount, external cost, identified payee and original request. Collections support claim-specific allocations, actual payment proof/rail, courier custody and real remittance without a second AR reduction.

- [x] Test SERVICE 2,000 with already-paid invoices: COD=2,000 to charge only; no invoice.paidAmount change. Test outsourced 5,000 client fee / 3,000 external cost as separate gross effects; PASS_THROUGH 3,000 -> liability, no revenue; SHOP_EXPENSE -> no customer claim.
- [x] Post the claim/accrual at approval and the receipt at actual collection; use classified posting profiles and dedupe keys, preserve unallocated/excess money as liabilities rather than dropping it.
- [x] Enforce independent approval for outgoing expense, available cash/actual payment rail, payee identity, credit policy and no refund beyond original allocations. Link reversals to original receipt; no deletion of posted money.
- [x] Surface claims and linked receipts in the customer statement, fulfillment detail, financial reports, and courier settlement view without multiplying rows.
- [x] Run charge lifecycle/rollback/replay/concurrent allocation regressions.

## Task 5: Aftercare without a second sale or inventory deduction

**Create:** `server/services/fulfillment/aftercare.ts`, `server/services/fulfillment/aftercareQueries.ts`, `server/services/__tests__/aftercare.test.ts`. Aftercare source integration into delivery/courier/return readers belongs to coordinator after handoff.

**Interfaces:** `createAftercareCase(input,actor)`, `approveAftercareCase(input,actor)`, `prepareAftercareExecution(input,actor)`, `dispatchAftercareExecution(input,actor)`, `confirmAftercareDelivery(input,actor)`, `cancelAftercareCase(input,actor)`, `listAftercareCases(input,actor)`, `getAftercareCase(id,actor)`. Lines identify original invoice item, original component variant and base quantity with disposition MISSING_HELD/REPLACEMENT/REPRINT, evidence and approval. Every physical execution owns its source identity and committed quantities.

- [x] Test historical bundle snapshot selection, returned/previously allocated quantity caps, requester/checker separation and branch scope.
- [x] MISSING_HELD requires original consumption evidence and physical held-goods confirmation: maintain sold-goods custody only, zero new branchStock/COGS/revenue/AR/commission. Never apply an ordinary stock reservation to already-deducted goods.
- [x] REPLACEMENT issues real additional base quantity through `applyMovement`, costs it once to quality/loss expense, and leaves original invoice/collection unchanged. REPRINT consumes only new specified materials via a linked rework execution, not a new sale.
- [x] Each execution becomes a real delivery source with FK and COD=0, SHOP fee, tracking/proof and fee accrual/payment. Original invoice is historical reference, not another collectible invoice. Failed delivery retains custody until verified return.
- [x] Prevent races with return/correction, repeated issuance and changed-payload retries. Close only after delivery and explicit resolution of remaining liabilities.
- [x] Run integration snapshots of stock quantities/value, receipts, AR, revenue, expenses and courier fee for success/replay/rollback.

## Task 6: Operational UI and API integration

**Create:** `server/routers/fulfillmentRouter.ts`, `client/src/pages/FulfillmentHub.tsx`, bounded components under `client/src/components/fulfillment/`. **Modify after handoff:** root router/routes/navigation, POS/reception/order/invoice/delivery entry links, typed source renderers and printed shipment/receipt documents.

- [x] Use existing READ/FULL module procedures and operation permission inventory, services accept Actor only. Zod money contracts use existing money schemas; no business writes in router handlers.
- [x] One flat RTL workspace with tabs «طلبات التوصيل / الأجور الإضافية / معالجة ما بعد البيع», conventional DataTable/forms/AppSelect/MoneyInput and exact totals from server; all mutations have pending/error states and recoverable request identity.
- [x] Show a preparation request's source readiness and financial state separately; barcode links resolve request/shipment/aftercare source. Add clear entry points from sales/reception and the delivery hub.
- [x] Show real tender allocation, previous receipts, outstanding claims, carrier cost/liability, shortage disposition and approval before mutation. Documents show one consignment/fee and charge breakdown, aftercare COD zero.
- [x] Exercise desktop/narrow layouts against the running isolated app; verify role and branch restrictions in the actual-service integration cases. Record the boundary without claiming a browser role matrix that was not performed.

## Task 7: Whole-path verification and release

- [ ] Run `pnpm check` and `pnpm check:guards` with the pinned runtime; repair failures in the owned slice. Do not lower baselines.
- [ ] Reinitialize only the uniquely named session test database on 3310 after new schema; never use production mirror 3306. Run focused suites sequentially, followed by full `pnpm test` with TZ=UTC once for the integrated financial change.
- [ ] Obtain a fresh whole-diff review, resolve financial/source/concurrency findings, and record actual test results and remaining limits in the approved spec's implementation section.
- [ ] Fetch main, coordinate shared-file handoff/integration, rerun required gates only for new changes, create concise conventional commit(s), push and open/attach PR, monitor exact-head CI. Merge/deploy only under the existing authorized project protocol and outside another session's deployment window.
- [ ] Verify exact deployed SHA/artifact/health and read-only new routes; no financial test transactions on production. Release owned claims only after preserving work and evidence.

## Progress ledger

- Design approved by user; source snapshot verified; existing session worktree reused; coordination messages sent to the three active owners.
- Node 24.22.1 archive verified against the official checksum and installed locally for this task; locked dependencies installed without upgrades.
- Tasks 1, 2, 4 and 5 implemented and covered by isolated focused tests. Task 3 backend/UI implemented; shared legacy suites remain part of the full gate. Task 6 desktop exercise is in progress; release gates remain pending.
- Safe database: session-specific test schema on 127.0.0.1:3310; no production financial transactions. Migration 0403 applied twice to a baseline schema clone: 522 chunks per pass, all passed; actual FK/CHECK/generated-key verification passed.
- Focused evidence: 15 tender tests, 9 refund/cash-gate tests, 12 request + 3 counter-collection tests, 36 final charge/report/aftercare tests, and 38 pure UI/policy/source tests passed. The final 36 include actual courier excess/refund/remittance, as-of branch reporting and printed aftercare source lookup.
- Independent source and stock reviews completed; corrected real report custody deduplication and shared on-road counter-payment gaps. External continuity fixes f4062cc6 and 1a026a401 integrated three-way above typed new-source changes.
- Final typecheck initially found one missing approvedBy field in a strict helper Pick; corrected without casts. The complete gate must run on the final integrated source.

## Browser and local gate evidence (2026-10-24)

- Real isolated app and actual MySQL clone, no mocked financial transport: branch-scoped candidates load; SERVICE charge draft created and approved; printed-reference missing-source error is actionable; refund and excess screens load.
- Desktop 1366x900 and mobile 390x844 exercised. Document/body widths match viewport; light and dark display use existing theme. Screenshots are local review artifacts under output/playwright/.
- A cashier shortcut opens the real fulfillment request URL with branchId=3 in a new tab; the reception tab remains at its original URL. The same bounded component is wired into the retail header.
- Backend integration proves foreign-branch denial, requester/checker separation and inactive/ACCOUNTANT courier membership rejection. Browser exercise used the isolated owner account; no unperformed multi-role UI exercise is claimed.
- Production build passed, including PWA and HR bridge artifact/runtime/deployment smokes. Shared typecheck passed after the strict approvedBy correction. All 46 individual guard commands passed after generated source-line synchronization and date-locale corrections; the normal commit gate will run again on the final files.
- Full pnpm test (TZ=UTC) is running; its final result, exact-head CI and deployment are still pending.
