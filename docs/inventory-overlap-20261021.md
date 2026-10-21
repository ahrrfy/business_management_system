# Stocktake overlap prevention and settlement provenance

## Root cause

Overlapping stocktakes could approve different physical counts for the same branch
and variant. An older review could treat a newer stocktake settlement as an
ordinary post-count movement, preserve its review hash, and post a second
adjustment. A newer approved KEEP or matching count can also supersede an older
count without producing any inventory movement.

## Prevention

- Serialize scope changes and approvals with a consistent branch-before-session
  lock order and current reads.
- Prevent overlapping active scopes across creation, unknown-scan resolution,
  live scope expansion and opening-stock eligibility restoration.
- Reject stale approvals, partial approvals and signatures when another
  stocktake was approved after the effective count. Require a new physical count
  and a fresh review instead of guessing the correct stock balance.
- Derive settlement provenance from the approved stocktake and its effective
  count. Distinguish the counter, variance decision maker and final approver in
  inventory screens and exports; link to the source session.

## Historical investigation

The read-only investigation reconciles effective counts, inventory movements,
all session decisions, owned-stock accounting and consignment supplier effects.
Detailed production evidence and findings are retained locally and are not
included in this public repository.

Matching accounting entries prove that a decision was recorded; they do not
prove that the physical count was correct. A conditional calculation excluding
another stocktake is diagnostic evidence, not an authorized correction amount.
No historical inventory balances, supplier liabilities or accounting entries are
changed by deploying this protection.

Historical correction requires a physical recount, reconstruction of subsequent
operational movements, documented cost and ownership classification, and an
approved correction document. Do not delete history, replay purchase receipts,
reverse old differences blindly or invent balancing entries.

## Validation

- Integration tests cover concurrent exclusion, branch and variant independence,
  stale approvals and signatures, newer KEEP and matching counts, recount
  recovery, idempotency, and linked inventory/accounting effects.
- Provenance tests cover roles, effective counts, opening and manual movements,
  pagination and bounded query counts.
- The read-only audit utility has tests for safe SQL, KEEP, consignment and ledger
  reconciliation. It must never be used as a general correction tool.
- Type checks, repository guards and the full CI suite gate merging and release.
