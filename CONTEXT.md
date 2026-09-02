# Cash custody and daily reconciliation

## Glossary

- **Expected drawer cash**: opening float plus materialized drawer cash receipts minus materialized drawer cash payments. Counting never changes it.
- **Cashier count**: the physical cash counted before a shift is closed.
- **Custody handover**: drawer cash that has left the cashier and is held by a named recipient. It is posted to `CASH_IN_TRANSIT`, not treasury.
- **Treasury acceptance**: an independent count by the named recipient. Treasury is posted only after the count matches the declared handover.
- **Custody variance**: recipient count minus declared handover. It remains open for an independent recount or a maker-checker variance case; a real shortage becomes an employee receivable only when custody identifies that employee, while a surplus stays a liability.
- **Daily cash reconciliation**: one branch and one UTC business date, comparing the system treasury balance with a saved physical treasury count.
- **Daily variance resolution**: an approved adjustment that preserves the historical count as `RESOLVED_WITH_ADJUSTMENT`; a shortage is recognized as `LOSSES`, a surplus as `OTHER_LIABILITY`, and the day still requires a separate `CLOSED` certificate.

## Invariants

1. Closing a funded shift requires a named receiver who is active, belongs to the shift branch, and is not the person handing over the cash.
2. A handover has two accounting stages: drawer to cash-in-transit, then cash-in-transit to treasury after independent acceptance.
3. A mismatched count is evidence and never adjusts cash automatically. A separate maker-checker case, reason, evidence, and independent approval are required before a balanced adjustment is posted.
4. A daily reconciliation cannot close while shifts, custody receipts, custody variances, or cash-in-transit remain open.
5. Historical daily reconciliations are immutable evidence. Reopening requires a reason and separation of duties, except for an administrator.
6. Every daily reconciliation state other than `CLOSED`, including `MATCHED` and `RESOLVED_WITH_ADJUSTMENT`, blocks month close.
