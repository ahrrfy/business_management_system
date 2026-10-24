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
- [x] Run focused request, existing multi-invoice and shipment operation tests once integrated.

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

- [x] Run `pnpm check` and `pnpm check:guards` with the pinned runtime; repair failures in the owned slice. Do not lower baselines.
- [ ] Reinitialize only the uniquely named session test database on 3310 after new schema; never use production mirror 3306. Run focused suites sequentially, then require the complete financial-change suite through the eight disjoint CI shards with TZ=UTC.
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
- Backend integration proves foreign-branch denial, requester/checker separation and inactive/ACCOUNTANT courier membership rejection. Browser exercise used both the isolated owner and cashier accounts; the full role matrix is covered by the current-authority integration tests rather than claimed as a browser exercise.
- Production build passed, including PWA and HR bridge artifact/runtime/deployment smokes. Shared typecheck passed after the strict approvedBy correction. All 46 individual guard commands passed after generated source-line synchronization and date-locale corrections; the normal commit gate will run again on the final files.
- The early local full-suite run was stopped after the source/model changed during execution; no full local pass is claimed. The final complete suite must pass through the existing eight disjoint CI shards (TZ=UTC), with no coverage reduction. Deployment remains pending.

## Final authority and baseline synchronization

- Main 177fd8202517306b4c69df5ec29fd7f25720921c integrated, retaining independent charge obligations and the end-only statement opening fix. Shared deployment remains owned by the other active release; no concurrent deployment.
- Cost visibility is enforced from current persisted authority for charge/request/aftercare queries, current create/replay responses, and charge approval/payee execution. Concealed costs are null, not fabricated zero; payee payment receipts and nested material costs are omitted/redacted. A nine-case pure regression passed; four real-DB visibility cases are added for the final focused run. Original financial effects and actual stored values remain unchanged.
- The aftercare reference field resolves an exact printed number/barcode only. Explicit invoiceId/workOrderId links remain compatible; an unmatched number never silently selects another internal ID.
- Aftercare mutation results already contain IDs rather than cost; the audit cost was not a response leak. A delegated prepare/replay assertion preserves that existing contract and checks actual cost through privileged reads. No extra response field was added.
- Reception, retail and printing shortcuts were exercised in the real isolated app, including a real new-tab navigation that preserves the original cashier URL. Printing was visually corrected and rechecked after a missing prop binding was found.

## Acceptance gap closure and final model verification

- Added a complete pre-consolidation excess held-fee refund path: exact printed source preview, actual original receipt/rail, active invoice or READY work-order source, source locks shared with individual/group dispatch, pending-provider guard and original WO fee continuity after invoicing. All nine real-DB cases passed.
- Pure service work orders intentionally have no invoice items. REPRINT now uses the real work-order output quantity and FK, shares source caps through either the invoice or work-order entry, and permits a null product only for a service OUTPUT. MATERIAL still requires a real variant. All thirteen aftercare integration cases passed, including actual create/start/ready/deliver, service reprint and reverse-delivery denial.
- Regenerated unpublished migration 0403 from the updated schema. Both passes of 542 chunks succeeded on a separate baseline clone; between passes the three new CHECKs were removed deliberately and correctly restored. Actual constraints: 70 FK and 27 CHECK across the eight new tables plus consignments, with all three generated identity keys present.
- A real cashier browser session verified current cost redaction in the actual HTTP response (externalCost/payeePaidAmount/payeeRemaining=null, costVisible=false) and disabled cost approval with an explanation. The new refund preview shows an actionable missing printed-number error; narrow 390px layout has no horizontal overflow. Screenshots remain under output/playwright/.
- The actual cashier UI created a case for a delivered two-output service work order without a product or invoice item. Opening its invoice deep link resolves the real WO printed number and selects REPRINT without offering an old inventory movement.
- A fresh final test schema on local 3310 passed physical verification and all 72 targeted charge/report/aftercare/visibility/refund/cash-day/statement tests. The request/counter/tender/continuity suites passed 48 further cases. The legacy multi-invoice fixture was corrected to retain its real WO backlink and all 18 cases passed, including disconnected-source rejection. Total: 138 distinct targeted tests across 13 files; runtime source guards were preserved.
- The actual aftercare dispatch document renderer was exercised against a real isolated consignment (AFTERCARE_EXECUTION, invoiceId=null, COD=0, SHOP). Its sandboxed preview showed the real CN, recipient, zero collection, shop fee, QR and barcode; no physical print was invoked. Screenshot: output/playwright/aftercare-dispatch-slip-preview-final.png.
- Final release source inherits main d781d430096c84aeb384b602b9d1146062e575b9 (security PR #1550); its seven-file dependency/security-test delta contains no business changes. The root frozen install completed without dependency resolution or downloads. Final exact-head CI/review/deployment evidence will be recorded in the release PR to avoid a documentation-only rerun of the full suite.
- PR #1551's fresh review identified six integration gaps: fee-only COD tender linkage, held-fee refund AR classification (including WO), anonymous invoice delivery, CREDIT exclusion from courier goods collection, treasury owner authorization, and global provider-refund reference reservation. Narrow fixes and actual-path regressions were added. The superseded CI run was cancelled after its quality build passed; complete CI and re-review must run on the corrected head.
- Corrected-path verification passed 43 distinct affected DB cases (14 original-rail/excess refunds, two owner/closed-day payouts, 22 charge cases, five anonymous/CREDIT delivery cases) and 24 pure POS tests. The WO refund retains its real customer identity for source validation while its OTHER classification excludes it from AR; both the live statement and carried-forward opening were verified.
- The second review closed four additional cross-path gaps: charge-aware customer reconciliation with a real-drift negative control; visible/refundable anonymous courier excess; retained split-cash allocation after change; and replacement COD claims that reset the historical counter offset and require a fresh ACK. All 20 affected DB cases passed (nine financial/reconciliation, four split-change, six counter/reassignment and one anonymous excess lifecycle). No schema change or migration rerun was needed.
- The third review closed three linked financial paths: request-owned remittance is capped by this consignment's proven cash and never credits goods a second time; classified shortfalls remain courier assets outside customer AR; and delivered charge-only shipments close when the counter clears the final claim without remaining custody. All 22 affected DB cases passed, including real COMPANY statement collection, partial/full remittance, legacy compatibility, branch/date asset reporting and partial/custody counter-payment controls.
- Exact-head review completed without findings on d80ba4bf6e4a27c935f8e74e042af9cd73b5e956; quality build, authorization and Security passed. Full CI exposed three stale test contracts: WALLET is now a supported dedicated asset, a dispatch guard was reformatted, and reception delegates receipt writes. The test-only synchronization preserves unknown-rail rejection and the fail-closed writer inventory; all three affected cases passed locally. Product code remains identical to the reviewed head; final exact-head CI remains required.
- The completed full CI exposed eight failures across six files, including the three stale contracts above. The remaining compatibility fixes add the explicit React import required by classic test JSX, inline current-owner resolution for the strict approval source guard, and provide independent non-optional held-fee posting source components. Ownership and financial behavior are preserved. Local verification passed the three contract cases, ten approval/UI/real-refund cases and the producer coverage scan. The final complete exact-head CI remains pending; no full-suite pass is claimed.
