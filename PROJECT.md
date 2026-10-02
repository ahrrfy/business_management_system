# Project: Atomic Order Return on Delivery Fix

## Architecture
- **Return Engine**: `server/services/returnService.ts` (`returnSaleInTx`) is the single transactional entry point for all returns (`returns.create`, `returnSaleDirect`, `returnSaleAsOwner`, `returns.approveRequest`, `salesControlRequests:SALES_RETURN`).
- **Delivery Management**: `server/services/delivery/` manages consignments (`deliveryConsignments`), ledger entries (`deliveryLedgerEntries`), and lifecycle events (`deliveryEvents`).
- **Data Flow**: When a sales return occurs on an invoice linked to an active delivery consignment:
  1. `returnSaleInTx` locks party and consignment `FOR UPDATE` (already implemented in lines 421-556).
  2. Processes return items, restocks inventory, adjusts customer balance, and issues refund from cash drawer/treasury.
  3. Replaces the hard blocker `assertNoLiveConsignmentForReturn` with `reconcileDeliveryOnReturnTx`.
  4. `reconcileDeliveryOnReturnTx` atomically updates consignment status (`RETURNED` / `CANCELLED` / `SETTLED`), releases outstanding COD exposure (`COD_RELEASED` in ledger), and records delivery lifecycle events.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Allow Return on Active Delivery (R1) | Remove blocking `PRECONDITION_FAILED` in `returnService.ts` to allow returning invoices whose delivery consignment is `OUT_FOR_DELIVERY`, `PICKED_UP`, `ACCEPTED`, `ASSIGNED`, or `UNSETTLED`. | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Automatic Delivery Reconciliation (R2) | Automatically settle, return, or cancel active delivery consignment on return: release COD exposure via `COD_RELEASED` in `deliveryLedgerEntries`, update consignment status (`RETURNED` / `CANCELLED` / `SETTLED`), and record delivery events. | M1 | ORIGINAL_REQUEST §R2 |
| 3 | E2E & Integration Test Suite | Comprehensive tests covering returns for invoices in `OUT_FOR_DELIVERY`, `DISPATCHED`, `UNSETTLED`, full returns, partial returns, and regression testing on normal return flows. | M2 | ORIGINAL_REQUEST §Acceptance Criteria |
| 4 | Verification & Quality Gates | Pass `pnpm check`, `pnpm check:guards`, and relevant `pnpm test` suites, ensuring zero message-drift and full code compliance. | M3 | CLAUDE.md §3.1 & §4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Implementation | Implement `reconcileDeliveryOnReturnTx` in `server/services/delivery/` and integrate into `server/services/returnService.ts`. Remove blocking assertion. | None | DONE |
| M2 | Test Suite & Adaptation | Update existing tests in `server/services/__tests__/moneyTrailDelivery.test.ts` (M5, M8) and create comprehensive tests in `deliveryReturnReconciliation.test.ts`. | M1 | DONE |
| M3 | Quality Gates & Verification | Run type checks, guard ratchets (`check:guards`), unit/integration tests, and forensic audit. | M2 | DONE |

## Interface Contracts
### `returnService.ts` ↔ `delivery/returnReconciliation.ts`
- Function Signature:
  ```typescript
  export async function reconcileDeliveryOnReturnTx(
    tx: Tx,
    params: {
      invoiceId: number;
      consignmentId: number;
      returnedTotal: string; // Decimal string
      isFullReturn: boolean;
      actor: Actor;
      refKey?: string;
    }
  ): Promise<{
    reconciled: boolean;
    releasedCod: string;
    newParcelStatus: ParcelStatus;
    newMoneyStatus: DeliveryMoneyStatus;
    newConsignmentStatus: DeliveryConsignmentStatus;
  }>;
  ```
- Behavior:
  - If consignment has outstanding uncollected COD (`liveRemaining = max(0, codAmount - collectedAmount - counterSettledAmount)`):
    - Appends `COD_RELEASED` entry to `deliveryLedgerEntries` with partyId, consignmentId, amount.
    - Updates `counterSettledAmount` on `deliveryConsignments`.
  - Updates `deliveryConsignments`:
    - Full return on in-transit parcel (`OUT_FOR_DELIVERY` etc.): `parcelStatus = "RETURNED"`, `status = "RETURNED"`, `moneyStatus = (collectedAmount > 0 ? "SETTLED" : "CANCELLED")`, `settledAt = now`, `returnedAt = now`.
    - Parcel already delivered (`DELIVERED`): `parcelStatus = "DELIVERED"`, `status = "DELIVERED"`, `moneyStatus = "SETTLED"`, `settledAt = now`.
  - Appends `deliveryEvents` record with `eventType = "RETURN_SETTLEMENT"`.
  - Does NOT touch inventory (handled solely by `returnSaleInTx`).

## Code Layout
- `server/services/delivery/returnReconciliation.ts`: New dedicated delivery reconciliation service on return.
- `server/services/returnService.ts`: Replace `assertNoLiveConsignmentForReturn` calls with `reconcileDeliveryOnReturnTx`.
- `server/services/__tests__/deliveryReturnReconciliation.test.ts`: Dedicated integration test suite.
- `server/services/__tests__/moneyTrailDelivery.test.ts`: Update tests M5 & M8 to reflect the new allowed return behavior.
