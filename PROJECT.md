# Project: Database Triggers, State Machines & Operational Lifecycles Forensic Audit and Resolution

## Architecture
The system utilizes a multi-tier transactional architecture across Node.js/TypeScript backend services, Drizzle ORM, and MySQL 8.0/8.4 database engines.
- **Data Flow & Cross-Module Boundaries**:
  - `onlineOrders` (E-Commerce) <-> `invoices` (Sales/Billing) <-> `deliveryConsignments` (Delivery/Logistics) <-> `branchStock` / `stockReservations` (Inventory) <-> `cashShifts` / `financialPeriods` (Treasury/Accounting).
- **Enforcement Layers**:
  1. TypeScript Service Guards: Validation functions (`assertParcelTransition`, `invoiceCancellationGuard`, `assertDateWithinOpenPeriodTx`).
  2. Database Triggers: BEFORE INSERT / BEFORE UPDATE guards (`trg_online_orders_expired_activation_bu`, `trg_cash_missed_daily_bu`, financial period immutability triggers).
  3. Database Schema Constraints: Unique keys (`uq_consignment_source`), check constraints.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Online Order Expiry Trigger Fix | Update `trg_online_orders_expired_activation_bu` to allow rollback transitions (e.g. `SHIPPED` -> `PROCESSING`) and evaluate `NEW.reservationExpiresAt`. | M1 | Survey 1, Survey 2, Survey 3 |
| F2 | Owner Missed Daily Count Trigger Fix | Update `trg_cash_missed_daily_bu` to allow Owner self-approval per PR #962 / migrations 0333/0336. | M1 | Survey 1 |
| F3 | Consignment Re-Dispatch Uniqueness Fix | Ensure cancelled/returned consignments do not block re-dispatching orders/invoices. | M1 | Survey 1 |
| F4 | Delivery Parcel Transition Alignment | Add missing `CANCELLED` and `RETURNED` transitions from `ASSIGNED` in `assertParcelTransition`. | M2 | Survey 2 |
| F5 | Consignment Return Online Order Sync | In `delivery/returns.ts`, synchronize online orders for consignments with `sourceType === 'INVOICE'` and `invoice.sourceType === 'ONLINE'`. | M2 | Survey 2 |
| F6 | POS Formal Reservation Expiry Unblock | Allow cancelling `EXPIRED` reservations to refund stranded advance customer deposits in `reservations/lifecycle.ts`. | M2 | Survey 3 |
| F7 | Sales Cancel & Storefront Circular Deadlock Resolution | Resolve mutual lockout between `invoiceCancellationGuard.ts` and `orderFulfillmentService.ts` for orders in `PROCESSING` without active consignments. | M3 | Survey 3 |
| F8 | Invoice Correction Lockout Resolution | Allow `correctSale` in `correctionLookup.ts` when online order is in safe unassigned state (`PROCESSING` without active consignment). | M3 | Survey 3 |
| F9 | Sales Return Online Order Synchronization | Mirror `sale/cancel.ts` in `returnService.ts` by updating linked online order status upon full return to eliminate dangling shipments. | M3 | Survey 3 |
| F10 | Comprehensive Regression & Symmetry Test Suite | Full Vitest suite covering all reversal/cancellation paths, degraded edge cases, and deadlock scenarios. | M4 | Survey 1, Survey 2, Survey 3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Root Architectural Remediation (Triggers, Lifecycles & Reversals) | Features F1 through F9: Fix database triggers, state machine transitions, and reversal deadlocks | none | DONE |
| 2 | M2: Comprehensive Regression Suite & Acceptance Verification | Feature F10 & CHALLENGE-001: Relink online order on correctSale, Vitest regression suite, `pnpm check`, `pnpm check:guards` | M1 | DONE |

## Interface Contracts

### M1 ↔ M2: Database Trigger Guards
- `trg_online_orders_expired_activation_bu`:
  - `OLD.orderStatus IN ('PENDING')` guard condition.
  - Evaluates `COALESCE(NEW.reservationExpiresAt, OLD.reservationExpiresAt, DATE_ADD(OLD.orderDate, INTERVAL 24 HOUR))`.
- `trg_cash_missed_daily_bu`:
  - Drops prohibition of `NEW.reviewedByUserId = NEW.requestedByUserId` when review is performed by Owner.

### M2 ↔ M3: Delivery & Order Transitions
- `assertParcelTransition(current, next)`:
  - Allowed from `ASSIGNED`: `["ACCEPTED", "OUT_FOR_DELIVERY", "FAILED", "CANCELLED", "RETURNED"]`.
- `cancelSale` ↔ `onlineOrders`:
  - When `onlineOrder.status === 'PROCESSING'` and no active consignment exists, `safeOrderStatus` evaluates to true.
  - `cancelSale` cascades `onlineOrders.status = 'CANCELLED'`.

### M3 ↔ M4: Verification Contracts
- All reversal endpoints (`cancelSale`, `returnSale`, `cancelDeliveryAssignment`, `reverseDelivery`) must succeed symmetrically without trigger exceptions or unhandled TRPCErrors.
- `pnpm check` returns 0 errors.
- `pnpm check:guards` returns 100% pass across all 10 guards.

## Code Layout
- Migrations: `drizzle/migrations/`, `drizzle/migrations/extras/`
- Sales & Billing: `server/services/sale/`, `server/services/returnService.ts`
- Delivery: `server/services/delivery/`
- Online Store: `server/services/storeAdmin/`
- Reservations & Inventory: `server/services/reservations/`, `server/services/inventoryService.ts`
- Cash & Treasury: `server/services/cash/`, `server/services/voucher/`
- Tests: `server/services/__tests__/`
