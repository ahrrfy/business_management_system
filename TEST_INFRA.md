# E2E Test Infra: Comprehensive Atomic Permission Key-Tree Matrix & Governance System

## Test Philosophy
- **Opaque-Box & Requirement-Driven**: All test cases are derived strictly from authoritative specifications (`ORIGINAL_REQUEST.md`, `PROJECT.md`, and business governance rules) without coupling to internal private implementation details.
- **Strict Independence & Progressive Testability**: Tests set up their own state, run deterministically in any order, and maintain 100% backward compatibility with existing coarse 29-module permissions (`FULL`, `READ`, `NONE`) and server authorization gates.
- **Defense in Depth**: Testing spans four rigorous tiers: Equivalence Partitioning (Tier 1), Boundary Value Analysis & Fault Injection (Tier 2), Multi-Feature State Combinations (Tier 3), and Realistic Enterprise Operational Scenarios (Tier 4).
- **Zero Financial & Governance Leaks**: Every permission enforcement, operational ceiling check, sensitive data masking rule, and audit trail entry is strictly validated to ensure no unauthorized operation or data leakage can occur.

---

## Feature Inventory Mapping

| # | Feature | Description | Source | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross) | Tier 4 (Real-World) |
|---|---------|-------------|--------|:-----------------:|:-----------------:|:--------------:|:-------------------:|
| **F1** | **Domain.Resource.Action Taxonomy** | 10 operational domains, 75+ atomic keys taxonomy with TypeScript validation | ORIGINAL_REQUEST §R1, PROJECT.md F1 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F2** | **Digital Operational Caps Schema** | Quantitative caps (discount %, credit sale IQD, payment voucher IQD, expense IQD, refund IQD) | ORIGINAL_REQUEST §R1, PROJECT.md F2 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F3** | **Sensitive Data Masking Controls** | Masking controls for purchase cost, profit margin, supplier phone, and customer contact | ORIGINAL_REQUEST §R1, PROJECT.md F3 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F4** | **Role Default Presets & Dual Resolution** | Default templates for 11 roles + 3 cashier roles with resolution fallback and override hierarchy | ORIGINAL_REQUEST §R1, PROJECT.md F4 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F5** | **Safe Storage & Persistence** | Nullable JSON persistence on `users` and `roles`, safe column projection, audit logging | ORIGINAL_REQUEST §R3, PROJECT.md F5-F7 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F6** | **100% Backward Compatibility Engine** | Dual-layer resolution, envelope pattern normalization, legacy module preservation (`FULL`/`READ`/`NONE`) | ORIGINAL_REQUEST §R3, PROJECT.md F8 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F7** | **Collapsible Key-Tree & Dynamic Counters** | 10 domain cards with accordion expand/collapse and dynamic reactive grant counters (`granted/total`) | ORIGINAL_REQUEST §R2, PROJECT.md F10 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F8** | **8 Standard Atomic Action Toggles** | Binary toggles for view, create, edit, cancel/void, print, reprint, export, and approve | ORIGINAL_REQUEST §R2, PROJECT.md F11 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F9** | **1-Click Smart Presets Bar** | 9 operational role presets (Cashier, Sales Rep, Warehouse, Accountant, Purchasing, Operator, Manager, Auditor, Courier) | ORIGINAL_REQUEST §R2, PROJECT.md F12 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F10** | **Live Search & Arabic Spaces Preservation** | Intelligent search with 180ms debounce, preserving Arabic spaces, auto-expanding matched categories | ORIGINAL_REQUEST §R2, PROJECT.md F13 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F11** | **Visual Custom Override Highlighting** | 4 semantic states: Base Grant, Base Deny, User Override Grant (`+`), User Override Deny (`-`) via Safa tokens | ORIGINAL_REQUEST §R2, PROJECT.md F14 | ≥5 cases | ≥5 cases | ✓ | ✓ |
| **F12** | **Operational Caps & Masking UI Panel** | Dedicated controls for digital caps (`MoneyInput`) and masking toggles in User/Role management | ORIGINAL_REQUEST §R2, PROJECT.md F15-F16 | ≥5 cases | ≥5 cases | ✓ | ✓ |

---

## 4-Tier Test Methodology

### Tier 1: Feature Coverage (Primary Equivalence Classes)
Validates primary behavior (happy paths) for every feature with at least 5 distinct test cases per feature:
- **F1 (Taxonomy)**: Key structure verification across all 10 domains; resource-action validation; catalog integrity; metadata labels in Arabic; immutability of catalog definitions.
- **F2 (Caps Schema)**: Valid discount percentages within 0-100%; valid IQD currency amounts; caps inheritance from role; user caps specialization; non-numeric input validation.
- **F3 (Masking)**: Purchase cost suppression; profit margin suppression; supplier phone formatting/masking; customer phone/contact masking; unmasked access for privileged roles (`admin`, `manager`, `accountant`).
- **F4 (Presets & Resolution)**: Baseline resolution for all 11 system roles; section cashier roles (`retail_cashier`, `print_cashier`, `reception_clerk`); role-level customization; user-level overrides over role; root admin override immunity.
- **F5 (Storage & Persistence)**: Saving atomic maps to `users.atomicPermissions`; saving caps to `users.operationalCaps`; role definitions persistence in `roles`; safe columns projection excluding password/secrets; audit logging on permission modifications.
- **F6 (Backward Compatibility)**: Existing accounts with legacy `permissionsOverride` without atomic keys; dual-layer envelope extraction; deriving coarse 29 modules from atomic keys; zero regression on `requireModuleGate`; zero regression on `canSeeCostForUser`.
- **F7 (Tree & Counters)**: Initial grant counter calculation (`0/N` to `N/N`); dynamic counter increment on grant; dynamic counter decrement on revoke; domain card collapse/expand state; bulk domain toggle ("Grant All" / "Revoke All").
- **F8 (8 Action Toggles)**: Independent toggle for `view`; `create`; `edit`; `cancel`/`void`; `print`/`reprint`; `export`; `approve`; mutual independence across sibling actions.
- **F9 (Smart Presets Bar)**: Applying Cashier preset; applying Warehouse preset; applying Sales Rep preset; applying Accountant preset; applying Manager preset; applying Auditor preset.
- **F10 (Search & Filters)**: Matching Arabic keywords ("طباعة", "خصم", "سند"); preserving spaces between Arabic words ("أمر شغل"); case and alef-normalization; auto-expanding collapsed domain containing matches; filter toggle for "Overrides Only".
- **F11 (Override Highlighting)**: Base role grant (inherited neutral); base role deny (inherited muted); user explicit grant over base deny (highlighted positive `--sem-pos`); user explicit deny over base grant (highlighted negative `--sem-neg`); resetting override reverts to inherited state.
- **F12 (Caps & Masking UI)**: Caps input fields binding; percentage limits clamping (0-100%); IQD money formatting; masking boolean switch state updates; reset to role default values.

### Tier 2: Boundary & Corner Cases (Limits, Overflow, Negative Values)
Stress-tests boundary conditions, edge cases, and adversarial invalid inputs (≥5 cases per feature):
- **Limits & Overflow**: Discount percentage at exact boundaries `0%` and `100%`; discount percentage rejection at `-1%` and `101%`; IQD caps at `0` vs extreme values (`999,999,999,999`); JavaScript large integer precision preservation via Decimal string representations.
- **Malformed & Injected Keys**: Unknown domain injection (`hack.resource.action`); empty string keys `""`; whitespace-only keys `"   "`; script injection payload in keys `<script>alert(1)</script>`; special regex meta-characters in search query (`.*+?^${}()|[]\`).
- **Nullability & Empty States**: Null `atomicPermissions` and null `operationalCaps` falling back safely to base role defaults; empty object `{}` handling; nullish user overrides preserving role custom defaults; deleted custom role fallback to base role enum.
- **Conflicting Overrides**: Multiple concurrent mutations to user permissions; toggle flapping (rapid enable/disable); partial caps overrides where only 1 of 5 caps is specified; negative currency values in caps (`-5000 IQD`) strictly rejected.
- **Data Truncation & Serialization**: Extremely large atomic map with 500+ dummy keys; JSON serialization round-trip without field loss; whitespace preservation in search inputs during active typing.

### Tier 3: Cross-Feature Combinations (Pairwise Feature Interactions)
Validates interactions between disparate system subsystems:
- **Resolution × Persistence**: Modifying atomic overrides and operational caps in `userRouter.update`, saving to database, and asserting identical resolution on subsequent session retrieval.
- **Legacy Fallback × Atomic Overrides**: A user with both legacy `permissionsOverride` (`{ pos: "READ" }`) and atomic overrides (`{ "pos.invoice.create": true }`) resolves coherently with atomic precedence while legacy server gates remain satisfied.
- **Operational Caps × Financial Transaction Enforcement**: A cashier user with `maxDiscountPercent: 5` and `maxDiscountAmountIqd: 25000` attempting a sale with 10% discount is blocked by the operational cap engine.
- **Sensitive Masking × Catalog & Sales Querying**: A warehouse keeper with `maskPurchaseCost: true` querying inventory items receives sanitized payloads with `costPrice: null`, while an accountant with `maskPurchaseCost: false` receives full financial costs.
- **Search Filtering × Bulk Category Toggle**: Searching for "طباعة" filters the visible tree to 3 items; clicking "Select All" in the category only toggles the filtered matching items, not hidden items.
- **Smart Preset × Individual Override**: Applying the "Cashier" smart preset, then applying a custom grant override for `pos.drawer.open`, verifying that the preset base is retained while the individual override is highlighted.

### Tier 4: Real-World Enterprise Operational Scenarios
Simulates realistic, end-to-end production workflows across 10 operational roles:
1. **Scenario 1 — Retail Cashier (كاشير التجزئة)**: Limited to `pos.*` actions with 5% discount cap and 0 credit sale limit; cost price masked; attempts to void an invoice are rejected and require manager authorization.
2. **Scenario 2 — Customer Reception Clerk (موظف الاستقبال)**: Manages work orders (`reception.order.*`), takes customer advance deposits, sends proofs, but has 0 payment voucher spending cap and no inventory adjustment permissions.
3. **Scenario 3 — Print Workshop Technician (فني المطبعة)**: Views technical jobs, marks stages complete, consumes materials, but has customer phone numbers masked and cannot access sales prices or revenue reports.
4. **Scenario 4 — Warehouse Keeper (أمين المستودع)**: Performs transfers, records physical stocktakes, prints barcodes, but cannot approve stock adjustments (SoD), cannot see purchase costs, and has supplier phones masked.
5. **Scenario 5 — Purchasing Specialist (مسؤول المشتريات)**: Creates purchase orders and matches vendor invoices, sees supplier contact details and purchase costs, but cannot approve outgoing payment vouchers without treasury/manager approval (Maker-Checker).
6. **Scenario 6 — Treasury Accountant (محاسب الخزينة)**: Issues payment vouchers up to 1,000,000 IQD cap, reconciles cash shifts, views profit margins and unmasked costs, but cannot bypass executive break-glass limits.
7. **Scenario 7 — Field Sales Representative (مندوب المبيعات)**: Records customer visits, prepares quotations with up to 15% discount cap and 500,000 IQD credit limit, but has no cash drawer access.
8. **Scenario 8 — Delivery Courier (مندوب التوصيل)**: Confirms parcel handoffs, collects COD payments within courier screens, but cannot issue customer credit or access back-office accounting.
9. **Scenario 9 — HR & Payroll Officer (مسؤول الموارد البشرية)**: Computes payroll runs and records attendance, but cannot disburse payments without financial treasury sign-off (Separation of Duties).
10. **Scenario 10 — System Administrator & Auditor (الإدارة والتدقيق)**: System admin has unrestricted root access and audit export capability; external auditor has universal read-only access across all domains with zero mutation grants.

---

## Test Architecture & Execution

- **Test Suite Path**: `tests/e2e/comprehensivePermissionMatrixE2E.test.ts`
- **Unit & Helper Suites**: `shared/__tests__/atomicPermissions.test.ts`
- **Test Framework**: Vitest (Environment: Node / jsdom)
- **Timezone**: Strict UTC (`cross-env TZ=UTC`)
- **Pass/Fail Criteria**:
  - 100% of test cases pass with exit code 0.
  - Zero TypeScript type errors (`tsc --noEmit`).
  - Zero guard violations (`pnpm check:guards`).
  - Strict backward compatibility maintained for all 11 roles and legacy accounts.
