# Native HR administration contract gaps

This workspace deliberately fails closed where the server cannot prove branch isolation.

## P0 — company-wide reads behind a module grant

- `payroll.list`, `payroll.get`, and `payroll.summaryReport` accept no branch input and their
  services query every payroll run. `payroll.get` includes employee base salary and line totals.
- `leaves.list`, `leaves.balances`, and `leaves.balanceReport` accept no caller branch and their
  services query all employees and requests.
- recruitment applicant and vacancy administration is company-wide. Vacancy rows contain a
  `branchId`, but list/get/mutations do not enforce the actor branch; applicants are not scoped.

Until the routers enforce actor-aware scope, the native client exposes these workspaces only when
the session role is `admin` and the `hr` module grant authorizes the operation. A branch manager is
not allowed to download the collection and filter it after transport, because that would already
disclose the data.

## P0 — employee object ID authorization

`employees.list` can be constrained with the active `branchId`, and the native repository always
sends it and rejects any mismatching row. However `employees.get`, `employees.update`,
`employees.setStatus`, `employees.usage`, and account-link operations do not prove ownership by the
actor branch. The native UI only acts on IDs obtained from the branch-filtered list, but this is
defence in depth, not a server security boundary. The server must resolve the employee first and
reject a non-administrator whose `ctx.user.branchId` differs.

## P1 — payroll operation capabilities

Bootstrap describes only `hr = NONE | READ | FULL`. It does not distinguish payroll maker,
checker, payer, salary reader, leave approver, recruiter, or termination authority. The server has
maker/checker separation-of-duties guards, and their failures are surfaced, but the client cannot
predict which action is authorized. Add operation-level capabilities to bootstrap before exposing
these actions to custom roles.

## P1 — safe termination workflow

`employees.setStatus(terminated)` has irreversible side effects: account disablement and release
of attendance-device links. The native workspace intentionally offers active/leave transitions
only. A complete termination flow needs required date and reason, impact preview, explicit
confirmation, and a server-issued operation capability.

## P2 — mutation idempotency

Payroll approve/pay, leave decisions, recruitment stage changes, and vacancy publication accept no
client request ID. The UI locks a request locally and never auto-retries a financial mutation, but
an ambiguous network outcome must be reconciled by re-reading server state before any retry.
