# Project: Arab Vision ERP — Company Management & Profile System

## Architecture
- **Tenant Level**: Corporate identity stored in each tenant's isolated database (`companyProfile` table in `drizzle/schema.ts`). Administered via `/settings?tab=profile` in `AdminHub.tsx`. Dynamically consumed across print engines, document headers, POS receipt thermal rasterizer, and server PDF generators.
- **Platform Level**: Multi-company administration hosted on dedicated `/platform-admin` route (`PlatformAdmin.tsx`), connected to control database (`erp_control` via `controlSchema.ts`). Supports asynchronous company provisioning, one-time temporary credential handoff, instant activation toggles, and audit logs.
- **Physical Database Isolation**: Physical database-per-tenant architecture. Platform state remains strictly in `erp_control`, while company data resides strictly in isolated MySQL schemas (`erp_co_*`). Guarded by `AsyncLocalStorage` context binding and fail-closed `getDb()`. Live company inspections query tenant metrics on demand via `withTenantDb()`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Tenant Profile Tab & UI | Accessible `/settings?tab=profile` tab inside AdminHub with legal, commercial, contact, and logo fields | M1 | R1 |
| 2 | Tenant Profile Service & Router | `system.getCompanyProfile` and `system.updateCompanyProfile` with admin gate & atomic audit log | M1 | R1 |
| 3 | Dynamic Brand & Printing Overrides | Dynamic company identity resolution for report headers, POS receipts, and invoice PDFs | M1 | R1 |
| 4 | Platform Admin KPI Overview Cards | Summary metrics (total, active, inactive, pending provisions) in PlatformAdmin.tsx | M2 | R2 |
| 5 | Platform Company Inspection Drawer | Detailed `Sheet` drawer displaying DB parameters, live user/branch counts, and status toggle | M2 | R2 |
| 6 | Platform Company Inspection API | `platformAdmin.companies.inspect` querying tenant DB safely via `withTenantDb` | M2 | R2 |
| 7 | Provisioning Queue & Temp Credentials | Asynchronous company provisioning with one-time temporary credential handoff | M2 | R2 |
| 8 | Platform Audit Logging | Full audit trail of platform admin operations with actor email, action, and client IP | M2 | R2 |
| 9 | Strict DB Isolation & Security | Context-bound `AsyncLocalStorage` and fail-closed tenant connection policies | M3 | R3 |
| 10 | Quality Gates & Comprehensive Tests | Vitest unit tests, `pnpm check` (0 errors), `pnpm check:guards` (all 45 pass) | M3 | R3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Tenant Company Profile & Corporate Identity | UI tab in AdminHub, dynamic printing integration, and tRPC endpoints | none | DONE |
| 2 | Platform-Level Multi-Company Management Dashboard | PlatformAdmin KPI cards, Inspection Drawer, `companies.inspect` procedure, audit logs | none | DONE |
| 3 | Integration Verification, Quality Gates & DoD Compliance | Unit tests, `pnpm check`, `pnpm check:guards` (45 checks), end-to-end verification | M1, M2 | DONE |

## Interface Contracts

### Tenant Profile (`systemRouter` ↔ `CompanyProfile.tsx` / Printing)
- `system.getCompanyProfile`: `protectedProcedure.query() => CompanyProfileData`
- `system.updateCompanyProfile`: `adminProcedure.input(updateCompanyProfileSchema).mutation() => CompanyProfileData`
- `resolveCompanyIdentity(profile?: Partial<CompanyProfileData> | null): CompanyIdentity`

### Platform Inspection (`platformAdminRouter` ↔ `PlatformAdmin.tsx`)
- `platformAdmin.companies.inspect`: `platformAdminProcedure.input({ id: number }).query() => CompanyInspectionReport`
  - Returns: `{ company: CompanyDetails, metrics: { userCount: number, branchCount: number, status: "healthy" | "unreachable", error?: string } }`

## Code Layout
- `client/src/pages/CompanyProfile.tsx`: Tenant corporate identity management UI
- `client/src/pages/AdminHub.tsx`: Settings hub registering Company Profile tab
- `client/src/pages/PlatformAdmin.tsx`: Platform-level multi-company management dashboard
- `server/routers/systemRouter.ts`: Tenant system tRPC procedures (`getCompanyProfile`, `updateCompanyProfile`)
- `server/routers/platformAdminRouter.ts`: Platform tRPC procedures (`companies.inspect`, etc.)
- `server/services/companyProfileService.ts`: Tenant profile singleton service
- `shared/companyIdentity.ts`: Dynamic company identity types and resolver
- `client/src/lib/printing/*`: Printing brand overrides and dynamic consumption
- `server/routers/__tests__/companyProfileAuthority.test.ts`: Authorization unit tests
- `shared/__tests__/companyIdentity.unit.test.ts`: Identity resolution unit tests
- `client/src/lib/printing/__tests__/brandDynamic.unit.test.ts`: Printing dynamic brand unit tests
- `server/services/__tests__/companyProfileService.test.ts`: Service integration & invariant unit tests
- `server/routers/__tests__/platformAdminRouter.test.ts`: Platform inspection adversarial test suite
- `server/services/__tests__/companyProfileChallenge.test.ts`: 50-client concurrency and stress suite
