# Project: English Numerals Enforcement & Bundle Kit Production Dialog Audit

## Architecture
- **Client Tier**: React 19 + Vite + Tailwind v4 + shadcn/ui + TanStack Query + wouter.
  - Root: `client/index.html` configured with `lang="ar-u-nu-latn"` and `dir="rtl"`.
  - CSS: `client/src/index.css` tabular numbers and input direction overrides.
  - Production UI: `client/src/components/production/bundle-kit/*` (Multi-step wizard dialog: parameters, components, materials, review, success).
- **Network / API Tier**: tRPC v11 (`server/routers/productionRouter.ts`).
  - Layer rule: Zod validation only, Actor injection (`userId, branchId, role`), no business logic in router, no `ctx` leak to service.
- **Service / Database Tier**: Express + Drizzle ORM (MySQL 8) + `decimal.js`.
  - Transaction manager: `withTx(async (tx) => { ... })` in `server/services/tx.ts`.
  - Core service: `server/services/production/bundleProduction.ts` (deterministic locking, FIFO/WAVG calculation, stock deduction, atomic sub-orders).
- **Verification Harness**:
  - `pnpm check`: TypeScript strict typecheck (`tsc --noEmit`).
  - `pnpm check:guards`: 45 automated ratchets/guards.
  - `pnpm test:unit`: In-memory unit test harness (`vitest.unit.config.ts`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---|---|---|---|
| F1 | Global Latin Numerals (R1) | BCP 47 `ar-u-nu-latn` in `index.html` and font styling in `index.css` | M1 | Survey 1 |
| F2 | Input Component LTR / Latin enforcement (R1) | `client/src/components/ui/input.tsx` LTR and language defaults for numeric types | M1 | Survey 1 |
| F3 | Bundle Kit Components Step Layout (R1) | Explicit table column widths, zero overlap, `whitespace-nowrap select-none` | M1 | Survey 1 |
| F4 | Bundle Kit Badges & Button Tokens (R1) | `whitespace-nowrap shrink-0` on all badges; WCAG AA semantic `variant="success"` on buttons | M1 | Survey 1 |
| F5 | Review Step Arabic-Indic Digit Input (R1) | Normalize `linkedWorkOrderId` input via `digitsArabicToLatin` in `BundleKitReviewStep.tsx` | M1 | Survey 1 |
| F6 | Transaction Atomicity & Rollback (R2) | `withTx` wrapping all mutations in `bundleProduction.ts` with all-or-nothing guarantee | M1 | Survey 2 |
| F7 | Deterministic Row Locking (R2) | Deadlock prevention: lock products, variants, and branchStock in `ASC` order with `forUpdate` | M1 | Survey 2 |
| F8 | Stock Deductions & Backorder Guard (R2) | Strict stock availability verification with `respectProductBackorder: false` | M1 | Survey 2 |
| F9 | WAVG / FIFO Cost Precision (R2) | High-precision arithmetic via `decimal.js` and parent bundle cost synchronization | M1 | Survey 2 |
| F10 | Zod Schema Hardening & Max Bounds (R2) | Add upper bounds (`.max(1_000_000)`) to integer fields in `bundleProductionTypes.ts` | M1 | Survey 2, 3 |
| F11 | Adversarial Input Normalization (R3) | Handle zero quantities, multiple dots, negative values, and non-numeric characters gracefully | M1 | Survey 3 |
| F12 | Comprehensive Component Tests (R3) | Unit tests covering `BundleKitReviewStep`, `BundleKitMaterialsStep`, and adversarial scenarios | M1 | Survey 3 |
| F13 | 45 Automated Quality Guards (R3) | All 45 ratchets passing in `pnpm check:guards` with zero violations | M1 | Survey 3 |
| F14 | End-to-End Forensic Integrity Audit | Multi-agent review, adversarial challenger verification, and forensic audit | M1 | Survey 1, 2, 3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | End-to-End Remediation, Testing & Forensic Audit | UI numeral & layout fixes, Zod upper bounds, comprehensive unit tests, adversarial scenarios (ADV-01..13), guards & typecheck, forensic audit | none | DONE |

## Key Outputs
- Modified files:
  - `client/src/components/production/bundle-kit/BundleKitReviewStep.tsx`
  - `client/src/components/production/bundle-kit/BundleKitProductionDialog.tsx`
  - `client/src/components/production/bundle-kit/BundleKitMaterialsStep.tsx`
  - `client/src/components/production/bundle-kit/QuickRecipeCopyDialog.tsx`
  - `shared/bundleProductionTypes.ts`
  - `vitest.unit.config.ts`
- Added test suites:
  - `client/src/components/production/bundle-kit/__tests__/BundleKitReviewStep.test.tsx` (11 tests)
  - `client/src/components/production/bundle-kit/__tests__/BundleKitDialogBadges.test.tsx` (4 tests)
  - `shared/__tests__/bundleProductionAdversarial.test.ts` (18 tests)
- Verification results:
  - `pnpm check`: Exit 0 (0 diagnostic errors)
  - `pnpm check:guards`: Exit 0 across all 45 guards
  - Vitest bundle kit suites: 56/56 passing tests
  - All Reviewers & Challengers: APPROVE
  - Forensic Auditor: CLEAN

## Interface Contracts
### `BundleKitReviewStep` ↔ `digitsArabicToLatin`
- `e.target.value` passed through `digitsArabicToLatin` before `parseInt`.
- Input parsed to valid positive integer or `null`.

### `QuickRecipeCopyDialog` ↔ Design Tokens
- Save button uses `variant="success"` instead of hardcoded `bg-emerald-600`.

### `shared/bundleProductionTypes` ↔ Backend Services & Zod
- `bundleQuantity`: `z.number().int().positive().max(1_000_000)`
- `batchQty`: `z.number().int().positive().max(1_000_000)`
- `scrapQty`: `z.number().int().min(0).max(1_000_000).default(0)`
