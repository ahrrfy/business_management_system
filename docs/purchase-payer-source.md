# Purchase cash attribution: payer, not reviewer

Approval/audit identity is not cash ownership. Supplier payment and refund requests freeze the actual requesting payer/receiver's cash source in hashed canonical evidence. New cash requests use an explicitly selected own drawer or authorized treasury. Approval validates that source; it never substitutes the reviewer's drawer, a newer shift, or treasury. Noncash requests have no drawer source. Legacy pending cash requests without source evidence require rejection and resubmission; rejection and completed replay remain usable.

Invoice shipping/customs costs default to **unpaid accrual**. Selecting **already paid from my drawer** is a separate, explicit creator declaration. Saving freezes its source shift; the immutable revision includes source and shift. Approval posts its expense, receipt and settlement against that creator shift, retaining reviewer identity separately. Unchanged declarations survive unrelated edits; only the creator may change the protected source or amounts. A closed or foreign source fails without fallback.

An unresolved paid-shipping declaration blocks source-shift closure and identifies its invoice. It does not change physical counted cash or permit a false matching count. Immutable full PAYMENT_SETTLED event, entry and completed/approved CASH/DRAWER OUT prove that payment was recorded, including while a governed real refund is pending or complete. Cash expectation follows actual receipts, not the current obligation status.

Governed cancellation of unreceived goods retains declared physically paid shipping: the same transaction posts only shipping recognition/payment and cancels the goods order. It creates no goods receipt, inventory movement, supplier invoice or supplier payment. Completed decision replay returns the original result even after source closure; concurrent copies use a current-read idempotency check under domain locks.

Migration 0383 adds source/shift evidence columns only. Existing invoices/revisions default to ACCRUAL: historical cash claims are not fabricated or backfilled. No historical receipt, ledger entry or closed-shift handover is rewritten.

## Historical reconciliation remains separate

For PO233/235, the user confirmed supplier cash 546,729 IQD came from creator user8's sales drawer817, not approver user1's drawer811. Shipping2,000 IQD was already correctly recorded against817. The user physically counted and delivered888,500 IQD for811 but entered341,771 to satisfy the faulty close screen. Stored817 handover752,500 is system evidence, not independently verified physical cash. No internal drawer transfer occurred. Preserve all original receipts/ledger/close records; never create a fake refund or cancel an actual supplier payment. Historical application requires independently reconciled actual817 count/handover and an audited supported correction route.

## Verification boundary

Focused public-service integration tests cover two separate drawers, actual invoice shipping, wrong/closed sources, declaration ownership, idempotency, concurrency, cancelled goods, shift closing, governed real refund, and reviewer-neutral supplier payment/refund. Real MySQL migration dry-run and local browser/component checks supplement them. Full tests/build/security gates must pass in eight-shard CI before merge/deploy. Production verification must be read-only; no live financial test records.
