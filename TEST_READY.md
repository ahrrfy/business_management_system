# E2E Test Suite Ready — Prevent Duplicate Invoice Returns & Cross-Module Interlock

## Test Runner
- **Command**:
  ```bash
  pnpm exec cross-env TZ=UTC TEST_DATABASE_URL="mysql://root:testpw@127.0.0.1:3310/erp_prevent_duplicate_invoice_returns_e2e_test" DATABASE_URL="mysql://root:testpw@127.0.0.1:3310/erp_prevent_duplicate_invoice_returns_e2e_test" vitest run server/routers/__tests__/salesReturnCartIdempotency.test.ts
  ```
- **Execution Result**: 27 passed | 0 failed (100% Passing)
- **Pre-Push Gates**: `pnpm check` (Clean TypeScript), `pnpm check:guards` (10 Guards passing)

## Test Architecture & Coverage Summary
The test suite in `server/routers/__tests__/salesReturnCartIdempotency.test.ts` provides comprehensive, requirement-driven, opaque-box testing covering all 10 features (F1 to F10) across four rigorous testing tiers:

| Tier | Test Count | Description | Status |
|------|:----------:|-------------|:------:|
| **Tier 1: Feature Coverage** | 10 | Complete happy-path and primary invariant verification for each individual feature F1 through F10. | **10/10 PASS** |
| **Tier 2: Boundary & Corner Cases** | 9 | Strict validation of edge cases: zero refund amount, amount exceeding remaining total, cash refund exceeding actual paid cash, quantity exceeding sold quantity, foreign unbilled variants, terminal dead statuses (`RETURNED`, `CANCELLED`, `SUPERSEDED`), and exact boundary full returns. | **9/9 PASS** |
| **Tier 3: Cross-Feature Combinations** | 5 | Bi-directional state interlocking: Return -> Cancel rejection, Cancel -> Return rejection, sequential step-down returns, walk-in return immunity during invoice lock, and in-cart line splitting anti-circumvention. | **5/5 PASS** |
| **Tier 4: Real-World Retail Workflows** | 3 | End-to-end multi-shift cashier cycles: Cash sale -> morning partial return -> evening completing return -> lock/block; multi-line invoice partial return with remaining item availability; damaged item return (`DAMAGED`) with loss recording and zero saleable restock. | **3/3 PASS** |
| **Total Test Suite** | **27 tests** | **Exhaustive coverage of F1–F10 across all lifecycle transitions** | **100% PASS** |

---

## Detailed Feature Matrix (F1 – F10)

| Feature | Description | Tests Covering Feature | Status |
|:-------:|-------------|------------------------|:------:|
| **F1** | **Backend Idempotency Replay Guard**: `executeSalesReturnCart` caches `clientRequestId` and safely replays previous receipt/response without duplicating financial entries or inventory movements. | T1-F1 | **VERIFIED** |
| **F2** | **Client Request ID Handling**: Acceptance and unique tracking of disparate `clientRequestId` keys across consecutive cart transactions. | T1-F2 | **VERIFIED** |
| **F3** | **Red Alert / Dead Invoice Predicate**: Instant detection of dead invoice statuses (`RETURNED`, `CANCELLED`, `SUPERSEDED`) and zeroing `maxRefundable` in `inspectInvoiceForReturn`. | T1-F3, T2-6, T2-7, T2-8 | **VERIFIED** |
| **F4** | **Action Disablement & Qty Clamping**: Preventing returns exceeding remaining base item quantities and updating remaining items. | T1-F4, T2-4 | **VERIFIED** |
| **F5** | **Walk-in Return Preservation**: Seamless execution of returns without invoice reference (`invoiceNumber: undefined`) for unregistered walk-in customers. | T1-F5, T3-4 | **VERIFIED** |
| **F6** | **Atomic Cancellation Interlock**: Blocking cancellation on invoices that have been fully returned (`RETURNED`), preventing double refund/double restock. | T1-F6, T3-1, T4-1 | **VERIFIED** |
| **F7** | **Cancellation UI Guard Invariant**: Pure predicate verification ensuring `isDeadInvoiceStatus` and `isDeadInvoice` correctly classify dead vs active states. | T1-F7 | **VERIFIED** |
| **F8** | **Enriched Return Inspection Backend**: `inspectInvoiceForReturn` delivers precise breakdown of lines, unit prices, sold base quantities, prior returned quantities, remaining refundable totals, and dead invoice status. | T1-F8, T4-2 | **VERIFIED** |
| **F9** | **Return Disclosure & Status Transition**: Automatic transition of invoice status to `RETURNED`, tracking `returnedTotal`, and zeroing effective refundable amount when fully returned. | T1-F9, T2-9 | **VERIFIED** |
| **F10** | **Error Message Standardization**: Structured error messages complying with `appErrorMessage` (`what`, `why`, `doThis`) across all return rejections. | T1-F10 | **VERIFIED** |

---

## Isolation & Reliability Guarantees
1. **Isolated Test Database**: Provisioned dedicated schema `erp_prevent_duplicate_invoice_returns_e2e_test` on `127.0.0.1:3310` to eliminate test collision between concurrent background worker sessions.
2. **Sequential Suite Execution**: Configured `describe.sequential` blocks across all tiers to guarantee serial execution, preventing DDL/DML lock contention in MySQL.
3. **Clean Teardown**: Uses table truncation/deletion with foreign key checks toggled safely, ensuring zero cross-test state leakage.

---

## Cashier Roles & Down Payment / Deposit Refund Integration (الاستقبال / التجزئة / الطباعة)
- **Suite**: `server/routers/__tests__/cashierRolesRefundAndCancel.test.ts`
- **Result**: 5 passed | 0 failed (100% Passing)
- **Features Verified**:
  1. **Reception Cashier (`reception_clerk` / `workorders: "FULL"`)**: Full authority to inspect returns, fetch open branch shift drawers, and execute cash returns directly refunded from their active shift drawer with auto-resolved shift fallback.
  2. **Print Cashier (`print_cashier` / `print_operator` / `pos: "FULL"`)**: Full authority to inspect returns, execute card returns with POS device reference, and cancel held sales (`cancelHeldSale`) with partial cash down payment/deposit refunded to the active shift drawer.
  3. **Retail Cashier (`retail_cashier` / `sales: "FULL"`)**: Retains complete access to sales return and cancellation workflows.
  4. **Strict Audit & Ledger Integrity**: All cash refunds generate `receipts` with `direction: "OUT"`, `cashBucket: "DRAWER"`, `shiftId`, and `invoiceId`, generating corresponding `PAYMENT_OUT` accounting entries with zero unlinked records.
  5. **Card Refund POS Device Reference**: Strictly enforces transaction reference on non-zero card refunds, preventing untraceable financial outflows.
  6. **UI Down Payment Refund Dialog**: `HeldOrdersDrawer` features an intuitive dialog when cancelling held orders with customer deposits, providing options for CASH (shift drawer), CARD (with POS reference), or TRANSFER.

