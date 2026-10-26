# Purchase Tender Implementation Plan

> Execute the approved design in the isolated purchase-tender-settlement session. Use focused implementers and a final financial review; preserve one writer per file.

**Goal:** complete purchase settlement from drawer, treasury, company card or explicitly linked existing payment without duplicate disbursement.

**Architecture:** immutable shared tender union, existing native payment requests/decisions for new money, explicit BOOK allocation for existing money. A prior payment allocation and any remainder payment commit with goods/invoice posting.

**Tech Stack:** TypeScript, React/tRPC, Drizzle/MySQL, decimal.js, Vitest.

## Global constraints

- Preserve CASH/CREDIT, existing financial/branch/maker-checker/stock contracts and unrelated work.
- All money uses decimal helpers; all writes transactional; historical originals immutable.
- Reuse CARD_BANK account mapping; do not invent a bank-account model or automatic bank confirmation.

## Work ledger

- [x] Tender contract and persistence: shared/purchaseTender.ts; purchase/types.ts, order.ts, revisions.ts; purchaseRouter input/detail projection. Verify immutable changes and edit round trips.
- [x] Existing payment adoption: purchase/priorPayment.ts and focused DB tests; BOOK projections/reversal companion. Verify equal, partial, unused balance, foreign source, replay, cancellation and no additional cash/AP effects.
- [x] Atomic remainder settlement: supplierPayments.ts, automaticInvoicePosting.ts and controls.ts. Verify CARD receipt/ledger/account provenance, actual remaining amount, source locks, rollback and governed replays.
- [x] UI and documents: PurchaseTenderField, PurchaseNew/Edit, approval and purchase print/details. Render three choices, previous payment evidence/amount, immutable source restoration and supplier-specific summaries.
- [x] Advance refund lifecycle: bind the actual incoming refund to the original supplier payment; preserve the actual refund rail, restore only current invoice capacity on cancellation, retain bounded immutable allocation evidence and recognize owned system reversals.
- Release gates: focused red/green DB/UI tests; pnpm check; pnpm check:guards; full financial suite; browser verification; final diff review, commit/PR and exact-head CI. Deployment remains conditional on the final CI and security results recorded on the PR.

## Verified local evidence

- Ten focused UI/printing suites after main integration: 118 tests passed (`.codex/purchase-merged-ui.log`).
- Seven additional navigation tests passed; actual browser navigation opened refund #99 and then original #81 with the page mounted. The vouchers page now handles the receipt deep link.
- Fifty-three focused financial DB cases passed, including prior-payment allocation, remainder settlement, refund/cancellation, a large audit document, and actual governed return/exchange reversals. Independent re-review closed all three confirmed refund findings.
- Nine related financial suites passed 154 cases (`.codex/purchase-related-financial.log`).
- Candidate lookup filters native/legacy/exchange/fulfillment claims and unavailable capacity before the 500-eligible-source bound. Three regressions cover 501 native receipts, allocated-versus-unused capacity and direct selected-receipt validation. Eligible overflow still fails explicitly; no truncated result proves absence.
- Typecheck and all 49 guards passed after correcting iterator compatibility and the SSR test props.
- Creation/edit browser fixtures exercised actual pages and captured mutation payloads; wide and 390px screenshots are in `output/playwright/`. These are local UI checks, not production transactions or bank confirmation.
- Final full-style refund form and purchase creation captures are in `.codex/qa/`; the refund form submitted the original source ID and the different actual refund method without viewport overflow.
- PR review corrections: preserve saved pre-tender cash sources until explicit replacement; enforce the receipt's 100-character card-reference limit; scope prior evidence to the requested order before its bound; include owned exchange settlement/reversal receipts. Focused UI cases passed 17/17 and evidence DB cases 10/10.
- The large-evidence fixture now uses 400 targets, so it exceeds the old 8192-byte cap independently of generated ID lengths; the targeted replay/cancellation case passed. The earlier 300-target fixture measured 8184 bytes on CI's fresh IDs.
- Full local suite is still running. Its unit phase passed 6197 tests; later source changes require final-head CI before release.
