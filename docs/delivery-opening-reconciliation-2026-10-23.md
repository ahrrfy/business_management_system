# Delivery opening custody reconciliation

The rerunnable phase-two bootstrap previously imported a party's entire cached custody as a party-only opening, even when consignment ledger entries already represented that money. Later native collections could therefore acquire a second custody effect on a deployment.

The bootstrap now completes all consignment snapshots first, then imports only a positive, unrepresented residual. It aggregates the party across branches, retains a shared party's nullable branch, and leaves negative or excess ledger custody for investigation. Existing opening keys remain occupied on replay.

Historical correction uses `deliveryOpeningExclusions`: an immutable evidence record for one complete, original opening. The canonical delivery ledger predicate validates the source ID, party, branch, amount, type and event key before excluding it. Unreviewed openings remain effective. Statements, obligations, reconciliation and delivery financial summaries share that predicate.

Apply a historical exclusion only after matching the **entire** opening to either native custody at its original cutoff or traced legacy dispatch, collection, remittance and completed treasury receipt sources. An equal current total alone is insufficient evidence. Preserve source exports and their hashes privately. Preview with rollback, apply all reviewed records and audit events in one transaction, verify protected source hashes, and verify that replay writes nothing. No receipt, remittance, invoice, cash, inventory or accounting entry is created or rewritten by an exclusion.

Validation covers native and partial coverage, genuine unattributed custody, duplicate snapshots, bootstrap ordering, shared branches, unreviewed later collections, source matching, immutable evidence, atomic rollback and read-model propagation in `deliveryOpeningCustody.test.ts`, alongside the existing canonical ledger tests.
