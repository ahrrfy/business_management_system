# Supplier voucher settlement implementation plan

**Goal:** A supplier payment voucher automatically allocates oldest-first in the backend and posts cash, AP and invoice settlement exactly once in one transaction.

**Design:** Keep one pending voucher receipt; create a linked existing supplier payment request using a reserved deterministic request key. Native supplier payment approval materializes that same receipt, its single ledger posting and its allocations. No new accounting engine or schema is needed.

**Constraints:** IQD voucher amounts allocate only to eligible IQD invoices in the selected supplier and branch. USD retains its existing explicit currency/rate workflow. Preserve evidence quarantine, cash-source ownership, active-owner approval, period locks, partial payments and refund controls. Never infer payment from the supplier's net balance. Freeze allocations on request and recheck them on approval. Reject changed-payload retries. No production data correction.

- [x] Task 1: Write failing persistence tests for FIFO partial/full settlement, manual allocations, request/approval replay, concurrent approval, invalid scope, stale invoices, insufficient funds, rejection and cancellation. Write independent pure-money FIFO tests.
- [x] Task 2: Add the shared decimal allocation contract and native payment/voucher receipt bridge. Reserve its request-key namespace, reuse the receipt on approval from either surface, release reservations on rejection/withdrawal and route approved refunds through existing governed supplier refunds.
- [x] Task 3: All automatic allocation stays in the backend; no distribution screen or separate settlement request. Expose only a read-only saved-allocation summary in existing voucher details. Refresh supplier, purchase, statement and voucher data after successful writes.
- [ ] Task 4: Run targeted DB and UI tests, typecheck, all guards, full financial test suite, build and visual verification. Independently review financial/concurrency paths and fix confirmed findings. Commit, push and verify CI before integration/release under the project workflow.

## Contracts

`VoucherInput.supplierAllocations?: {supplierInvoiceId:number; invoiceVersion:number; amount:string}[]` freezes an explicit distribution; omission selects eligible invoices FIFO by invoiceDate then id. `supplierCashSource?: {mode:'DRAWER'|'TREASURY'; shiftId?:number|null}` defaults to treasury, preserving the existing voucher source.

The existing voucher creation endpoint remains the user entry point. No extra allocation query, allocation screen or settlement action is required. Saved invoice allocations are available from the existing voucher details endpoint for read-only audit.

The linked supplier request is keyed `VOUCHER-SUPPLIER:<receiptId>`. Its public native request wrapper rejects that namespace. `decideSupplierPaymentInTx` reuses and signs that receipt, validates its identity and materializes it once; native and voucher approval cannot create a second receipt or ledger entry. Pending requests remain zero-effect. Approved cancellation uses governed native refund, avoiding an unallocated generic reversal.

## Validation oracle

For any approved amount P: supplier AP delta = -P; one completed OUT receipt and one PAYMENT_OUT entry; sum(net allocations) delta = P; invoice/PO open debt delta = -P; replay adds zero rows or money. A failing operation leaves every financial table unchanged. Partial payment keeps remaining debt open; exact full payment settles it. Pending/rejected/withdrawn requests have zero cash/AP effect and do not reserve funds after closure.
