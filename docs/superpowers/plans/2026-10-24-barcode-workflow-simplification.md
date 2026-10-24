# Barcode workflow simplification — approved implementation plan

User approval: 2026-10-24, full revised operational/accounting/inventory plan in this chat. Base: main f67c8787eb7124fb5806d0ed257dd2e0bb107ee3 (PR #1551). Reuse the delivered financial model; do not replay historical corrections.

## Binding outcome

The ordinary employee stays in the familiar barcode stations. Add only one station, **النقص والتعويض**, inside the current workflow page. No inner tab maze, new mandatory browser tab, synthetic product, duplicate sale/payment/stock issue, or client-authoritative balance calculation.

- Cashiers: describe an extra service and its amount alongside goods/delivery; one genuine payment for all allocations, including charge-only checkout.
- Dispatch: consecutive scans, one recipient/branch, one physical shipment/fee and one confirmation. A WO and its existing invoice are one economic source. Preserve a valid single-source legacy path.
- Cancellation: source-aware cancel/reassign/return declaration; cancellation alone never proves physical return.
- Collection: scan a consignment or member source to the current economic claim; never select a group twice. Current counter payments, CREDIT exclusion, excess/customer custody, refunds and carrier fee settlement remain linked.
- Invoice correction: current values/version and existing relationships; actionable constraints instead of a dead end.
- Returns: distinguish sale reversal, actual parcel receipt and actual money refund.
- Aftercare: original scan, evidence/quantities, independent approval, actual preparation, barcode per physical execution, ordinary dispatch, delivery/return, fee/custody settlement and closure.
- Preserve branch selection for authorized cross-branch actors, actual shift/drawer, current operation authority and cost redaction. The courier must be an explicit employee selection, not the first list entry.
- A committed dispatch with failed printing stays committed and offers reprinting the same CN. Keep scanner/draft state on recoverable failure; discard stale responses after context changes.

## Financial and stock contracts

### One checkout, actual allocations

Extend the current checkout/payment binding rather than call sale + charge collection independently from the browser. The server computes and persists goods, SERVICE/other approved charge and held-delivery allocations; consumes one provider proof once; commits all local effects atomically. Invoice paidAmount remains goods-only. No provider operation can be rolled back by a SQL transaction: confirmed payment/lost response is recoverable and never prompts a second terminal charge. Refunds stay on original allocations/rail and remain pending until actual external execution.

Acceptance oracle: goods 50,000 + SERVICE 3,000 + held delivery 5,000 = actual receipt 58,000, goods revenue/payment 50,000, service revenue 3,000, held-fee liability 5,000; goods stock OUT once, service/fee no automatic stock movement. Cash change applies once; retain mixed-tender/credit controls.

Extend existing OperationalCaps with a current-authority SERVICE amount cap. Sum charges across the same business operation, not per line or receipt. Missing/zero cap means independent approval, never unlimited. Direct capped execution accepts SERVICE only, externalCost=0 and no external payee. Above cap, outsourced, pass-through and shop expense keep proper independent review. Store actor/policy evidence; recheck at commit. A fully paid immediate guest SERVICE needs no fake customer or AR; deferred claims need a real customer.

### Aftercare and controlled settlement

- MISSING_HELD: original sale/custody movement only, no new sale/OUT/cost.
- REPLACEMENT: one real issue at its actual issue cost, one quality expense, no new revenue.
- REPRINT: new actual materials only; linked execution work, no new commercial sale.
- Execution barcode identifies the real prepared batch and links to the case/original source; aftercare COD=0 and feeCollection=SHOP.
- Administrative pre-pickup cancellation requires verified state and real shop custody, with no collection/earned-fee conflict. Post-pickup uses declare return -> actual receipt/inspection -> eligible reissue/settlement. Preserve previous CN history and prevent second material issue on reissue.
- Stopped prepared cases need preview -> independent review -> controlled settlement. Restore only proven usable physical quantities at their original issue cost; consumed/damaged materials do not become available stock or get expensed twice. Original sold/customer-owned goods require a real source-linked rights/return settlement. Carrier accrual/payment and customer refund rights cannot be silently waived.
- Persist delivered versus settled quantities separately. Closure requires all approved quantities accounted for, no open custody/carrier due/customer right and all required external refunds actually completed. Never mark undelivered quantities delivered to close a case; never create balancing fiction.

## Interfaces and integration

- Shared typed workflow scan preview: source identity, canonical economic key, versions/current relations, visible current money and allowed actions/reasons. Support invoice/WO/online/CN, fulfillment request, execution and standalone charge identifiers; old printed barcodes/QR remain valid.
- Server batch dispatch orchestration delegates to the appropriate existing domain transaction, without materializing a source twice. Preview/scanning alone never posts.
- Checkout extends existing payloads/results compatibly with extra charge inputs/IDs and persisted receipt allocation/recovery evidence. Never accept browser-computed authorization, balances or posting lines.
- Source-specific cancellation/reassignment and settlement commands carry expectedVersion and stable clientRequestId. Current authority/branch guards run before fresh execution and replay responses.
- Existing decision/work lists surface the actual approval/preparation tasks and return to the same station/context. Staff dispatch of an approved prepared execution does not grant cost approval or treasury payment authority.
- Convert old fulfillment URLs/shortcuts to the corresponding station preserving document IDs, branch, drafts and pending refunds. Keep old functions reachable until complete replacements exist.
- Refresh relevant views after committed events; no high-frequency polling or full-page invalidation on every scan.

## Coordination and active external contract

Worktree: D:/business_management_system-worktrees/barcode-workflow-simplification-20261024. All writers share it, with explicit non-overlapping coord claims. Parent alone edits hot files, migration journal and generated catalogs, runs DB tests/build/commit/release. Child writers do not commit, push, initialize DBs or run full suites.

Density wave 35 owns Reception/PaymentPanel/Amounts/Submission/CheckoutPayload/CheckoutReceipts, receptionCheckoutService/receptionRouter/workOrderRouter and workOrder create/deliver/cancel until explicit handoff. Do not edit those live-owned files. Their confirmed incoming contract:

- optional payments[1..10] in receptionCheckout and draftCommit: { amount: raw tender, method, externalPaymentAttemptId?, externalPaymentDeviceId? };
- when payments exists, no scalar method/reference/proof or collectNow; paidAmount, if present, is a validated applied echo;
- held deposit first, CASH-only change, independent proof per CARD leg;
- deliveryFeeTender separate; combinedWithPaymentIndex binds its leg, and fee is excluded from payments amounts;
- paymentSummary { tenderedAmount, appliedAmount, changeAmount } and paymentAllocations { paymentIndex, receiptId, invoiceId?/workOrderId?, method, amount, reference } cover new goods/deposit only, excluding DLV-FEE;
- actual WO receipt readers replace synthetic aggregate receipts; no schema change.

Integrate that final ref before touching its files. Coordinate _integration with the security owner; no simultaneous deployments.

## Tasks and acceptance ledger

- [x] 1. Pin approved contracts, coordination, isolated dependencies/test DB, station/role/state baseline and gap list.
- [x] 2. Implement capped SERVICE/guest/approved-charge transaction primitives, current caps and owner settings, with independent financial tests.
- [x] 3. Integrate unified payment allocation/recovery into all actual cashier paths and UI after wave-35 handoff; prove 58,000 oracle and mixed/refund paths.
- [x] 4. Implement typed scan/batch dispatch/current group/charge/execution previews, authorization, canonical dedup and source-aware commands.
- [x] 5. Implement complete aftercare settlement/custody/pre-pickup cancellation, linked work/approval tasks and execution barcode/labels.
- [x] 6. Integrate consecutive-scan dispatch and all stations; embed aftercare, charge/refund context, preserve branch/shift and old deep links; remove mandatory navigation detours.
- [ ] 7. Close each verified gap; test roles/branches, FIFO/stale scans, lost responses, print failure, stock cost change and actual source-linked settlements. Exercise real isolated UI desktop/narrow/zoom/RTL and actual document renderer without physical printing. Verify migration twice on a baseline clone; run typecheck/all guards/final eight CI shards, exact-head review and safe merge; exact-main gates and managed deploy; production read-only proof; release claims.

Full-suite financial evidence compares real receipts/allocations, journals, cash/bank, AR/AP, carrier/customer custody, stock quantities/value and original issue identities; a balanced GL alone is insufficient. Baseline and final click/page counts must show ordinary cases stay at their station and batch dispatch has one final confirmation. No false UI pass from source inspection. Do not rerun unchanged full suites or expand unrelated scope.

## Progress

- New session isolated from current main using project session:new. Original worktree clean; external owners informed before writing. Active wave-35 overlaps are deferred, not overwritten.
- Integrated density wave35 after explicit handoff, then synced main d3be9d7f6. No foreign working changes overwritten; final release remains serialized with other sessions.
- Independent financial, native request/return, rights and recovery tests and actual isolated UI evidence are recorded in `docs/delivery-workflow-stations-acceptance.md`. Two independent review findings (driver eligibility and expanded FR source authorization) were corrected and re-reviewed. Final CI/review/deployment evidence belongs to the PR checks and managed release, after this source snapshot.
