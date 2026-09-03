# Cash custody and daily reconciliation

## Glossary

- **Expected drawer cash**: opening float plus materialized drawer cash receipts minus materialized drawer cash payments. Counting never changes it.
- **Cashier count**: the physical cash counted before a shift is closed.
- **Shift close return**: after the cashier count matches expected cash, the full drawer balance is moved atomically from `DRAWER` to `TREASURY`. It has no named receiver or later acceptance step.
- **Operational custody handover**: a separate mid-shift cash drop or branch transfer held by a named recipient. It is posted to `CASH_IN_TRANSIT` until accepted; this workflow is not part of shift close.
- **Treasury acceptance**: an independent count for operational custody handovers only. It is not required for the automatic shift-close return.
- **Custody variance**: recipient count minus declared handover. It remains open for an independent recount or a maker-checker variance case; a real shortage becomes an employee receivable only when custody identifies that employee, while a surplus stays a liability.
- **Daily cash reconciliation**: one branch and one UTC business date, comparing the system treasury balance with a saved physical treasury count.
- **Daily variance resolution**: an approved adjustment that preserves the historical count as `RESOLVED_WITH_ADJUSTMENT`; a shortage is recognized as `LOSSES`, a surplus as `OTHER_LIABILITY`, and the day still requires a separate `CLOSED` certificate.

## Invariants

1. Closing a shift requires an exact cash match, then moves the full counted amount directly to treasury in the same transaction and leaves the drawer at zero.
2. Shift close never asks for a receiver and never creates pending cash-in-transit. Mid-shift cash drops and branch transfers retain their separate two-stage custody workflow.
3. A mismatched count is evidence and never adjusts cash automatically. A separate maker-checker case, reason, evidence, and independent approval are required before a balanced adjustment is posted.
4. A daily reconciliation cannot close while shifts, operational custody receipts, custody variances, or cash-in-transit remain open.
5. Historical daily reconciliations are immutable evidence. Reopening requires a reason and separation of duties, except for an administrator.
6. Every daily reconciliation state other than `CLOSED`, including `MATCHED` and `RESOLVED_WITH_ADJUSTMENT`, blocks month close.
