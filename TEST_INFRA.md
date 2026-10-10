# E2E Test Infra: Database Triggers & State Machines Verification

## Test Philosophy
- Opaque-box & white-box verification derived from user requirements in `ORIGINAL_REQUEST.md`.
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinatorial Testing + Real-World Workload Testing.

## Feature Inventory Coverage Map
| # | Feature | Requirement | Tier 1 (Isolated) | Tier 2 (Boundary) | Tier 3 (Cross-Module) | Tier 4 (Real-World) |
|---|---------|-------------|:-----------------:|:-----------------:|:---------------------:|:-------------------:|
| F1 | Online Order Expiry Trigger | R1 | 5 | 5 | ✓ | ✓ |
| F2 | Owner Missed Daily Count Trigger | R1 | 5 | 5 | ✓ | ✓ |
| F3 | Consignment Re-Dispatch | R1 | 5 | 5 | ✓ | ✓ |
| F4 | Delivery Parcel Transitions | R2 | 5 | 5 | ✓ | ✓ |
| F5 | Consignment Return Online Order Sync | R2 | 5 | 5 | ✓ | ✓ |
| F6 | POS Formal Reservation Expiry | R2 | 5 | 5 | ✓ | ✓ |
| F7 | Sales Cancel Circular Deadlock | R3 | 5 | 5 | ✓ | ✓ |
| F8 | Invoice Correction Lockout | R3 | 5 | 5 | ✓ | ✓ |
| F9 | Sales Return Online Order Sync | R3 | 5 | 5 | ✓ | ✓ |
| F10 | Comprehensive Regression Suite | R4 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test Runner: Vitest (`pnpm vitest run`)
- Type Checking: `pnpm check`
- Guard Verification: `pnpm check:guards`
- Location of Test Suites: `server/services/__tests__/` and dedicated regression test file `server/services/__tests__/triggersAndStateMachinesRegression.test.ts`.

## Acceptance Thresholds
- `pnpm check`: 0 errors
- `pnpm check:guards`: 100% pass across all 10 architectural guards
- Vitest tests: 100% pass covering all forward, rollback, and cancellation paths
