# Project: Comprehensive Atomic Permission Key-Tree Matrix System

## Architecture
A three-tier, highly ergonomic, backward-compatible atomic permission and operational governance architecture for Al-Roya Business Management System:

1. **Catalog & Taxonomy Layer (`shared/`)**:
   - `shared/atomicPermissions.ts`: Defines `Domain.Resource.Action` key taxonomy (10 operational domains, 75+ atomic keys), operational caps schema (`OperationalCaps`), sensitive data masking controls, and default templates for all 11 system roles + 3 section cashier roles.
   - Dual-resolution engine: Computes atomic permission grants and effective operational caps while preserving legacy 29-module coarse permissions (`FULL`/`READ`/`NONE`) without breaking existing server gates (`requireModuleGate`, `canSeeCostForUser`).

2. **Storage & Persistence Layer (`server/` + `drizzle/`)**:
   - MySQL 8 instant schema addition: Nullable JSON columns `atomicPermissions` and `operationalCaps` on both `roles` and `users` tables.
   - Migration `0384_comprehensive_permission_matrix_caps`.
   - Services (`userService.ts`, `roleService.ts`) and Routers (`userRouter.ts`, `roleRouter.ts`): Secure CRUD, audit logging (`logAudit`), and safe projection (`SAFE_COLUMNS`).
   - Context resolution in `server/context.ts` injecting resolved atomic permissions and caps into session actor.

3. **High-Ergonomic Interactive UI Layer (`client/src/components/permissions/`)**:
   - Modular decomposition (<400 lines per file):
     - `PermissionMatrix.tsx`: Master coordinator and tab wrapper.
     - `PermissionPresetsBar.tsx`: 9 1-click smart presets (Cashier, Sales Rep, Warehouse Keeper, Accountant, Purchasing Specialist, Print Operator, Branch Manager, Auditor, Courier).
     - `PermissionCategoryCard.tsx`: Collapsible domain/category cards with dynamic reactive grant counters (`granted / total`, e.g. "8/12") and bulk action toggles.
     - `PermissionResourceRow.tsx` & `PermissionActionCell.tsx`: 8 standard atomic actions (عرض، إضافة، تعديل، إلغاء/عكس، طباعة، إعادة طباعة، تصدير، اعتماد) with Lucide icons.
     - `PermissionMatrixFilters.tsx`: Live intelligent search (180ms debounce, no live trim, preserving Arabic spaces, local 60fps state, auto-expanding categories) and filter by overrides.
     - `OperationalCapsPanel.tsx`: Digital caps inputs (`MoneyInput`) and sensitive data masking toggles.
     - Distinct visual override highlighting: 4 clear states using Safa tokens (`--sem-pos-bg`, `--sem-neg-bg`).
   - Seamless integration into `UserEdit.tsx`, `RoleEdit.tsx`, and `AccountFields.tsx`.

## Feature Inventory
Every feature from user request and survey phase assigned to a milestone:

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Domain.Resource.Action Taxonomy | 10 domains, 75+ atomic keys taxonomy with TypeScript types | M1 | Survey 1 (R1) |
| 2 | Operational Caps Schema | Discount %, credit limit IQD, voucher IQD, expense IQD, refund IQD | M1 | Survey 1 (R1) |
| 3 | Sensitive Data Masking Schema | Cost price, profit margin, supplier phone, customer contact | M1 | Survey 1 (R1) |
| 4 | Role Default Presets & Resolution | Templates for 11 roles + 3 cashier roles with fallback logic | M1 | Survey 1 (R1) |
| 5 | Drizzle Schema & Migration 0384 | Add `atomicPermissions` and `operationalCaps` to `users` and `roles` | M2 | Survey 2 (R3) |
| 6 | Safe Columns & Service Integration | Update `userService.ts`, `roleService.ts`, `SAFE_COLUMNS`, audit logs | M2 | Survey 2 (R3) |
| 7 | Routers & Context Resolution | Update `userRouter.ts`, `roleRouter.ts`, `server/context.ts` | M2 | Survey 2 (R3) |
| 8 | Backward Compatibility Engine | 100% compatibility for legacy accounts, zero regression on existing gates | M2 | Survey 2 (R3) |
| 9 | Modular Matrix Component Tree | Clean components under `client/src/components/permissions/` (<400 lines) | M3 | Survey 3 (R2) |
| 10 | Collapsible Tree & Grant Counters | Domain cards with accordion collapse, dynamic counter badges ("8/12") | M3 | Survey 3 (R2) |
| 11 | 8 Standard Atomic Action Toggles | Checkboxes/toggles for view, create, edit, cancel, print, reprint, export, approve | M3 | Survey 3 (R2) |
| 12 | 1-Click Smart Presets Bar | 9 operational role presets with instant 1-click apply | M3 | Survey 3 (R2) |
| 13 | Live Search with Arabic Spaces | 180ms debounced search, preserving Arabic spaces, auto-expand | M3 | Survey 3 (R2) |
| 14 | Custom Override Highlighting | 4 visual states (+ grant in `--sem-pos`, - deny in `--sem-neg`, inherited) | M3 | Survey 3 (R2) |
| 15 | Operational Caps & Masking UI | `MoneyInput` caps and sensitive data masking toggles panel | M3 | Survey 3 (R2) |
| 16 | User & Role Screens Integration | Integrate new matrix into `UserEdit.tsx`, `RoleEdit.tsx`, `AccountFields.tsx` | M3 | Survey 3 (R2) |
| 17 | E2E Testing Suite (Tiers 1-4) | Comprehensive opaque-box test suite for all features, publish `TEST_READY.md` | E2E-Track | Dual Track |
| 18 | Final E2E Pass & Adversarial Hardening | 100% pass of E2E suite + Tier 5 coverage hardening | M4 | Dual Track |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Atomic Taxonomy & Resolution Core | `shared/atomicPermissions.ts`, schemas, templates, resolution helpers, unit tests | None | DONE |
| M2 | Schema Migration & Persistence | `drizzle/schema.ts`, migration `0393`, `userRouter`, `roleRouter`, `userService`, `context.ts` | M1 | DONE |
| M3 | Interactive Matrix UI & Ergonomics | `client/src/components/permissions/*`, `UserEdit.tsx`, `RoleEdit.tsx`, `AccountFields.tsx` | M1, M2 | DONE |
| E2E | E2E Testing Track | Independent requirement-driven test suite (Tiers 1-4) & `TEST_READY.md` | M1 | DONE |
| M4 | Final E2E Pass & Coverage Hardening | 100% pass of E2E suite + Tier 5 adversarial hardening | M2, M3, E2E | DONE |

## Interface Contracts
### `shared/atomicPermissions.ts` ↔ Server & Client
- `type AtomicPermissionKey = string;`
- `type AtomicPermissionsMap = Record<AtomicPermissionKey, boolean>;`
- `interface OperationalCaps { maxDiscountPercent?: number | null; maxDiscountAmountIqd?: string | null; maxCreditSaleLimitIqd?: string | null; maxPaymentVoucherAmountIqd?: string | null; maxExpenseVoucherAmountIqd?: string | null; maxRefundAmountIqd?: string | null; }`
- `interface SensitiveDataMasking { maskPurchaseCost?: boolean | null; maskProfitMargin?: boolean | null; maskSupplierPhone?: boolean | null; maskCustomerContact?: boolean | null; }`
- `function resolveAtomicPermissions(role: string, customRoleAtomic?: AtomicPermissionsMap | null, userAtomicOverrides?: AtomicPermissionsMap | null): AtomicPermissionsMap;`
- `function resolveOperationalCaps(role: string, roleCaps?: OperationalCaps | null, userCapsOverrides?: OperationalCaps | null): Required<OperationalCaps>;`

### `drizzle/schema.ts` ↔ `roles` & `users`
- `roles.atomicPermissions: json("atomicPermissions")` (nullable)
- `roles.operationalCaps: json("operationalCaps")` (nullable)
- `users.atomicPermissions: json("atomicPermissions")` (nullable)
- `users.operationalCaps: json("operationalCaps")` (nullable)

## Code Layout
- `shared/atomicPermissions.ts`: Taxonomy, types, constants, default presets, resolution functions.
- `shared/__tests__/atomicPermissions.test.ts`: Pure unit tests for taxonomy and resolution.
- `drizzle/schema.ts`: Table definitions for `users` and `roles`.
- `drizzle/migrations/0393_comprehensive_permission_matrix_caps.sql`: Migration script.
- `drizzle/migrations/meta/_journal.json`: Migration journal entry (idx: 393).
- `server/routers/userRouter.ts`: Validation schemas, input/output types.
- `server/routers/roleRouter.ts`: Validation schemas, input/output types.
- `server/services/userService.ts`: Data access, `SAFE_COLUMNS`, audit logging.
- `server/services/roleService.ts`: Role persistence, audit logging.
- `server/context.ts`: Session context enrichment.
- `client/src/components/permissions/`:
  - `PermissionMatrix.tsx`
  - `PermissionPresetsBar.tsx`
  - `PermissionCategoryCard.tsx`
  - `PermissionResourceRow.tsx`
  - `PermissionActionCell.tsx`
  - `PermissionMatrixFilters.tsx`
  - `OperationalCapsPanel.tsx`
  - `types.ts`
- `client/src/pages/UserEdit.tsx`: Integration.
- `client/src/pages/RoleEdit.tsx`: Integration.
- `client/src/components/form/AccountFields.tsx`: Integration.
