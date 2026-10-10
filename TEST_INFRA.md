# TEST_INFRA.md — Store Order Fulfillment Automation & Commission Integration

## 1. Test Philosophy & Principles
- **Opaque-Box Requirement-Driven Verification**: Test against functional contracts and business invariants without coupling to private implementation internals.
- **4-Tier Testing Methodology**:
  - **Tier 1: Feature Coverage**: Verify primary behavior (happy paths) for every single feature in isolation (claims, contact updates, preparation, dispatch, COD invoicing, sweeper).
  - **Tier 2: Boundary & Corner Cases**: Stress-test extreme edge conditions, zero/negative quantities, concurrency race conditions, 24-hour expiration barriers, and illegal state machine transitions.
  - **Tier 3: Cross-Feature Combinations**: Test complex multi-step pipelines and negative interlocks (e.g., claim -> prep -> dispatch -> commission attribution, cancellations after invoicing, sweeper vs active claims).
  - **Tier 4: Real-World Scenarios**: Full end-to-end operational life cycles from customer order placement to warehouse staging, courier assignment, ledger double-entry balancing, and commission settlement.
- **Ledger Invariant Enforcement**: "No dinar is lost, wasted, or unattributed." Every dispatch must generate balanced double-sided entries (`AR`, `INVENTORY`, `COGS`, `REVENUE`) and attribute fulfiller commissions as `role: 'FULFILLER'`.

---

## 2. Feature Inventory & Requirement Traceability

| ID | Feature Name | Core Functions / Modules | Primary Requirements |
|---|---|---|---|
| **F1** | Order Claiming & Ownership | `claimOnlineOrder` (`orderFulfillmentService.ts`) | R1 (Row locking, CONFLICT on duplicate, idempotent self-claim, admin override) |
| **F2** | Contact Logging & Phone Confirmation | `updateOnlineOrderContact` (`orderFulfillmentService.ts`) | R1 (Status update, atomic notes persistence, auto-confirm on `CALLED_CONFIRMED`) |
| **F3** | Order Preparation & SLA Metrics | `markOnlineOrderPrepared` (`orderFulfillmentService.ts`) | R1, R3 (Duration calculation, minimum 1-min clamp, `PROCESSING` transition) |
| **F4** | Dispatch to Courier & COD Sales Invoicing | `dispatchOnlineOrder` (`dispatchOnlineOrder.ts`) | R1, R2 (`createSaleInTx`, base unit inventory deduction, consignment generation, `SHIPPED` status) |
| **F5** | Financial Attribution & Commissions | `createSaleInTx` (`sale/create.ts`, `commissionService.ts`) | R2 (`attributeToUserId`, `salesRepId`, `role: 'FULFILLER'`, two-sided accounting) |
| **F6** | 24-Hour Stock Reservation Sweeper | `sweepExpiredOnlineOrdersOnce` (`onlineOrderExpirySweeper.ts`) | R1 (Dynamic ATP exclusion, expired pending order cancellation, reason preservation) |
| **F7** | State Transition & Guard Enforcement | `setOnlineOrderStatus`, `@shared/onlineOrderStatus.ts` | R1, R4 (Strict transitions, rejection of illegal jumps, invoice cancellation lock) |

---

## 3. Test Architecture & Tier Structure

```
server/services/storeAdmin/__tests__/orderFulfillmentE2E.test.ts
├── Tier 1: Feature Coverage (Isolation Happy Paths)
│   ├── T1.1: Order Claiming (PENDING -> CONFIRMED with claimedByUserId)
│   ├── T1.2: Contact Updates (WHATSAPP_SENT, notes persistence)
│   ├── T1.3: Telephone Confirmation (CALLED_CONFIRMED auto-promotes PENDING to CONFIRMED)
│   ├── T1.4: Order Preparation (markPrepared calculates duration, transitions to PROCESSING)
│   ├── T1.5: Courier Dispatch & COD Invoicing (creates real invoice, consignment, sets SHIPPED)
│   ├── T1.6: Base Unit Inventory Deduction (moves stock OUT with reference INVOICE)
│   ├── T1.7: 24h Reservation Sweeper (cancels expired orders with designated reason)
│
├── Tier 2: Boundary, Edge & Corner Cases
│   ├── T2.1: Concurrency Race Condition (simultaneous claims serialized via `for update`, 1 wins, 1 gets CONFLICT)
│   ├── T2.2: 24-Hour Expiration Boundary (orders expired by 1ms rejected on claim or confirmation)
│   ├── T2.3: Illegal State Transitions (e.g. PENDING -> SHIPPED, DELIVERED -> PROCESSING, CANCELLED -> CONFIRMED)
│   ├── T2.4: Terminal State Immutability (DELIVERED and CANCELLED cannot be prepared or claimed)
│   ├── T2.5: Zero/Minimum SLA Duration Clamp (< 60s clamped to 1 minute)
│   ├── T2.6: Post-Invoice Cancellation Guard (cannot cancel order after invoice is issued)
│
├── Tier 3: Cross-Feature Interactions & Pipeline Interlocks
│   ├── T3.1: Sequential Pipeline (Claim -> Contact -> Preparation -> Dispatch -> Commission)
│   ├── T3.2: Attribution Hierarchy (preparedByUserId takes precedence over claimedByUserId for FULFILLER commission)
│   ├── T3.3: Courier Dispatch Idempotency (re-dispatching returns existing invoice & consignment)
│   ├── T3.4: Active Reservation Immunity (unexpired orders protected from sweeper)
│   ├── T3.5: Multi-Item Complex Order Allocation & Bundle Expansion in Dispatch
│
└── Tier 4: Real-World End-to-End Operational Scenarios
    ├── T4.1: Complete Customer Store Order Lifecycle (Web Order -> Claim -> WhatsApp -> Prep -> Dispatch -> Ledger Verification)
    ├── T4.2: High-Volume Multi-Staff Processing with Competing Claims and Hand-offs
    └── T4.3: Edge Recovery & Self-Healing (orphaned invoice recovery on dispatch retry)
```

---

## 4. Execution & Environmental Parameters
- **Test Runner**: Vitest (`vitest run`)
- **Required Environment**: `cross-env TZ=UTC`
- **Database Context**: Real MySQL test database via `getDb()` and Drizzle schema transactions (`withTx`).
- **Isolation Guarantee**: Explicit table truncations in `beforeEach` (`onlineOrders`, `onlineOrderItems`, `invoices`, `invoiceItems`, `inventoryMovements`, `deliveryConsignments`, etc.).
