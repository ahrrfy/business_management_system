# E2E Test Infra: Atomic Order Return on Delivery Fix

## Test Philosophy
- Opaque-box, requirement-driven verification derived directly from `ORIGINAL_REQUEST.md`.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Cross-Feature Combinations + Real-World Workload Testing.
- Strict accounting and ledger verification: every return must verify no monetary leaks, no dangling COD exposure, and proper inventory restoration.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Return order while consignment is `OUT_FOR_DELIVERY` | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | Automatic settlement/cancellation of delivery consignment on return | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | Ledger exposure release (`COD_RELEASED`) and zero courier shortfall | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |

## Test Architecture
- Test Runner: `vitest` (with `cross-env TZ=UTC`)
- Test Directory: `server/services/__tests__/`
- Test Files:
  - `server/services/__tests__/deliveryReturnReconciliation.test.ts` (New comprehensive suite)
  - `server/services/__tests__/moneyTrailDelivery.test.ts` (Updated tests M5 & M8)
- Pass/Fail Semantics:
  - All tests must pass with exit code 0.
  - Zero validation errors when calling `returnSale` or `returnRouter.create` on invoices linked to active delivery.
  - Assert that `deliveryConsignments` statuses transition to `RETURNED` / `CANCELLED` / `SETTLED`.
  - Assert that `deliveryLedgerEntries` contains `COD_RELEASED` matching the uncollected COD amount.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Cash on Delivery order dispatched; customer cancels at door before courier collects; cashier processes full return in store | F1, F2, F3 | High |
| 2 | Multi-item order out for delivery; customer returns 1 of 3 items; partial return processed in store; remaining items remain active with adjusted COD | F1, F2, F3 | High |
| 3 | Order delivered by courier but unremitted (`DELIVERED`, `UNSETTLED`); customer brings items back to store for return | F1, F2, F3 | High |
| 4 | Order on courier run; return initiated by manager via `salesControlRequests` approval; delivery reconciles automatically | F1, F2, F3 | High |
| 5 | Return with inventory restock vs without restock on active delivery | F1, F2, F3 | Medium |

## Coverage Thresholds
- Tier 1: Feature Coverage (≥5 tests per feature)
- Tier 2: Boundary & Corner Cases (≥5 tests per feature)
- Tier 3: Cross-Feature Interactions
- Tier 4: Real-World Workload Scenarios
