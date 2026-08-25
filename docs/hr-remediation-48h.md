# HR P1 Remediation — Before/After

## Scope

This remediation is limited to confirmed code-level gaps in the HR security and financial-governance review. It is applied on `session/hr-remediation`, based on commit `098d1610b1dc1b1f6b7a541d2f49883dbc3d8163`, with no direct production changes.

## Implemented fixes

| ID | Before | After | Evidence |
|---|---|---|---|
| HR-SEC-01 | `employee.clearance` accepted a caller-supplied employee ID and called `getEmployeeClearance` without a branch scope. A branch-scoped HR reader could therefore request clearance details for an employee in another branch. | The router derives `companyBranchScope(ctx.user)` and passes it to the service. The service limits the employee lookup by `employees.branchId` for branch-scoped callers; owner/admin retain company scope. | `server/routers/employeeRouter.ts`, `server/services/hr/offboarding.ts`, regression case in `server/services/__tests__/employeeOffboarding.test.ts` |
| HR-FIN-01 | Leave audit `newValue.days` recorded the client-provided `input.days`, while the service correctly calculated the inclusive date range server-side. This could make the audit evidence disagree with the persisted financial basis. | `days` remains optional only for backward compatibility, is ignored as a source of truth, and the audit event records `lv.days` from the persisted row. The self-service route no longer sends a dummy `days: 1`. | `server/routers/leaveRouter.ts`, `server/services/leaveService.ts`, `server/routers/superAppRouter.ts` |
| HR-FIN-02 | Attendance-settings audit recorded the partial client payload, not the merged/normalized row returned by the server. | Audit records the actual persisted values from `row`, including defaults and unchanged fields. | `server/routers/attendanceRouter.ts` |

## Verification

- `pnpm test:unit`: **136 test files passed; 1,111 tests passed**.
- Targeted database-backed suites: **blocked safely** by the test harness because the configured MySQL target is port 3306 and `ALLOW_TEST_DB_PORT_3306=1` was not set. No test database was touched.
- Targeted TypeScript check over the affected server routes/services: **passed** using `/home/ubuntu/tsconfig.hr-remediation.json`.
- `pnpm build`: **passed**; frontend, server, HR bridge artifact gate, and deployment self-tests passed. Existing large-chunk warnings remain non-blocking.
- `pnpm check:guards`: all guards before Docker Compose passed, but the overall command returned non-zero because the environment does not contain the `docker` executable. This is an environment block, not a source failure.
- Full project `pnpm check`: attempted twice and could not complete because TypeScript exhausted the sandbox Node heap / was terminated. The targeted check passed; the full check remains a release-environment task.

## Not silently marked fixed

The following P1 controls require an isolated integration database, deployment configuration, or an approved Iraqi payroll policy and are therefore not claimed as completed by source-only edits: maker/checker validation across every production role, statutory payroll rates and filing/export approval, backup encryption and restore proof, device bridge deployment from a real source, and end-to-end branch isolation through authenticated HTTP sessions.

## Release gate

Do not deploy the branch until the blocked integration suites run against a disposable MySQL database, Docker guard checks pass in CI, the payroll legal configuration is approved by the responsible accountant/advisor, and backup restore evidence is attached to the release record.
