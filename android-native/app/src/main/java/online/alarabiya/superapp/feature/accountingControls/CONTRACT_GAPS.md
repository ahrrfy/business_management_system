# Accounting controls native contract gaps

This workspace intentionally implements only operations whose existing server contracts can be used safely from a native client. It never reconstructs balances, P&L, exchange cost, ledger effects, or reconciliation results locally.

## Release blockers for broader access

- `exchange.list`, `exchange.statement`, and `exchange.pendingDeposits` are company-wide reads. They do not accept or enforce the actor branch. The native workspace therefore exposes exchange data only to `admin` and `manager` sessions with treasury access. Branch accountant access must remain disabled until the server returns branch-scoped data or bootstrap exposes an explicit company-wide treasury capability.
- Exchange money mutations require an authoritative branch. The native workspace disables them when bootstrap has no active `branchId`, including an all-branches administrator. A future branch selector must be populated from an authorized server endpoint and the selected branch must be bound to the operation capability.
- `yearEnd.close` has no preview/dry-run endpoint. The native confirmation can describe scope and intent, but it cannot show authoritative totals before execution. Financial totals displayed after close come only from the server snapshot.
- `periodLock.lock`, `periodLock.unlock`, and `yearEnd.close` do not accept a client request identifier. The native UI serializes a foreground request and reconciles state afterward, but server-side idempotency is still required for robust retry after transport ambiguity.
- `exchange.approveDeposit` also has no client request identifier. Its server transition and separation-of-duties checks remain authoritative, but a response lost after commit must be reconciled by refreshing the pending queue rather than blindly assuming failure.

## Intentionally omitted operations

- Exchange-house create/update/activate are omitted because these master-data writes do not accept `clientRequestId`; create can also alter opening balances.
- Exchange transaction reversal is omitted because the route has no idempotency key and is financially destructive.
- Supplier settlement is omitted even though it is idempotent: the current workspace has no authoritative, permission-scoped supplier and purchase-order picker. Raw numeric IDs are not an acceptable substitute.

## Enforced native invariants

- Account tree is read-only and requires the server-derived reports grant plus a role supported by the current report contract.
- Period lock/unlock and year-end close are administrator-only, matching `adminProcedure`.
- Exchange reads fail closed outside company-wide treasury roles; writes additionally require `FULL` treasury access and the exact session branch.
- Deposit, withdrawal, and USD purchase send a stable `clientRequestId` that is retained across a failed attempt and cleared only after an authoritative success and refresh.
- Direct USD deposits remain labelled pending and are never added to a balance locally. Approval is a separate server transition and server-side separation-of-duties remains authoritative.
- All amounts, balances, exchange differences, period state, and year-end totals shown by the UI are mapped from server responses as strings without client-side financial arithmetic.
