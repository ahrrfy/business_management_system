# Delivery numbering: preserve the legacy branch/day floor

Production observation: at 2026-10-19T19:00:53.446Z, `delivery.dispatchInvoice`
failed on the unique `deliveryConsignments.consignmentNumber` index. A redacted
log classification confirmed the daily `CN` family and sequence 1; no production
financial rows were queried or modified. The deployed source was
`21fcb2fd42c2e23a7f8f6dbf3908b1308753f6a3`.

The migration to `documentCounters` preserved the `CN`/`DR` formats but omitted
the existing documents' floor. A missing daily counter started at 1. For a legacy
invoice, `dispatchInvoiceInTx` reaches `resolveConsignmentNumber`, then falls
back to the daily allocator. Its insert collides with a historical document.
The transaction rolls back its counter too, so retrying can hit the same number.

The allocator now locks the shared counter row before reading the numeric
maximum for the same branch/day. Cancelled documents remain part of history;
other branches, other days and non-numeric suffixes do not establish its floor.
The atomic increment uses `GREATEST(currentCounter, legacyFloor) + 1` and checks
safe integer bounds. An advanced counter is never reduced. The counter, document
and existing delivery effects still share the original transaction. No migration,
renumbering of old records, financial posting change or direct production SQL is
introduced.

The delivery-specific query uses the number index and returns one aggregate.
After integration with main `128817a`, the shared counter also retains main's
historical floor reader, which fetches matching document numbers into JavaScript.
CN/DR therefore execute that reader in addition to the delivery aggregate. Both
scan the matching day's suffixes; this is not a constant-time row-read or memory
claim. The isolated tests establish correctness, not full ERP performance.
The counter lock serializes current allocators even with an older read snapshot.
Coexistence with the pre-PR1510 GET_LOCK allocator is not qualified here; all
currently deployed workers had already moved to the counter allocator.

Validation uses synthetic data on a separately owned MySQL 8.4.11 instance at
127.0.0.1:13327, verified by PID, executable, datadir and listening port. The D1
qualification instance on 13326 and production are unchanged. Before the fix,
seven regressions failed, including the actual dispatch insert with the same
unique constraint as production. The first fixture-only failure (invalid invoice
source type) is retained separately and is not counted as bug reproduction.

The focused suite covers an empty day, absent/stale/advanced counters, cancelled
history, numeric order across 99999, branch isolation, remittances, eight concurrent
allocations, an older repeatable-read snapshot, actual dispatch/replay and a later
float-limit rejection with complete rollback of the selected counter, invoice,
customer, party, delivery, receipt, accounting and idempotency snapshots. It does
not execute or inspect a real customer's transaction.

Release requires normal type/guard hooks, independent review, complete exact-head
CI, and green push CI/audit on the resulting main commit before official
`pnpm prod:deploy` as deploy. Recheck live ownership and deployment locks first.
This fixes the observed delivery 500 mechanism. The separate overload 503 for a
font and final production stability remain open acceptance gates; D1 activation
and its next qualification stage must wait.
