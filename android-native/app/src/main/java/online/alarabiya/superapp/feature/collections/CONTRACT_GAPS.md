# Collections / credit-control native contract

This feature is deliberately a **credit decision control plane**, not a second receivables or CRM screen.

## Existing ownership boundaries

- `feature/receivables` already implements AR/AP reminder queues, reminder history, API sends, promises/skips, installments, installment payments, card-account movements, and reconciliation. Those contracts are not duplicated here.
- Customer notes belong to CRM. The current `customerNotes` service does not enforce note branch ownership for list/update/resolve/delete, so collections neither reads nor mutates them.
- Customer receipts already use the treasury voucher contract. Generic receipt entry remains in the finance/receivables owners rather than being copied into this feature without an authoritative customer-selection journey.

## Credit approval constraints

- `creditApproval.list` and `creditApproval.cancel` use `managerProcedure`, not a module capability. Native access therefore mirrors the server exactly: `admin` and `manager` only.
- Approval rows have no branch identifier and the endpoint is company-wide. The UI labels the register as company scope and never presents it as branch-isolated.
- The list does not return a status field. Status is not inferred from device time. Each page is labelled with the exact `ACTIVE`, `EXPIRED`, `CONSUMED`, or `CANCELLED` filter evaluated by the server.
- `creditApproval.create` has no `clientRequestId`. A lost response can leave a valid approval and a retry can create a second one, so native creation is omitted until the server offers idempotency.
- The sale-side `validateApproval` contract checks customer, amount, expiry, and single use, but does not compare `approvedBy` with the sale actor. Because managers can also execute sales, maker/consumer separation is not currently enforced by the server. Native approval creation remains omitted; this must be fixed server-side before exposing it.
- `creditApproval.cancel` also lacks a request identifier, but it is a monotonic state transition: only an unconsumed decision can move to cancelled. Native cancellation requires a reason, explicit confirmation, and a fresh server-filtered page after success. A transport failure is reported as ambiguous and must be resolved by refresh; the client never assumes cancellation.

## Financial authority

The feature displays `maxAmount` exactly as returned by the server and performs no balance, exposure, expiry, invoice, or eligibility calculations. Credit approval validation and single-use consumption remain entirely in the sale transaction on the server.
