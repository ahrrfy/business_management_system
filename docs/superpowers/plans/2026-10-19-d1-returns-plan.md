# Actual cash and credit returns in the isolated D1 lab

Scope: ordinary stocked POS invoices, partial and full returns, restock or damaged goods, CASH refund or registered-customer credit, unpaid/part-paid/paid credit invoices. Bundle, service, digital, delivery, installment and active double-entry modes remain rejected until their dedicated proof. No production changes.

Use the original `returnSaleDirect` service, original refund caps and full reversal engine. Capture exact effects in the existing atomic epoch protocol and independently signed recovery log before success. Reuse the existing three credit-lab bindings and stable writer; retain all existing rows, identities, master fixtures and journal prefix. Add only required projection tables and indexes. All schema extensions must be preserved in the offline restore package.

Acceptance: native workerd D1 and original MySQL parity for money, stock, WAVG, receipts, AR, ledger, document effects and audit; concurrent returns/collections; different-payload key conflicts; lost response; journal unavailable before/after source commit; writer restart; signed restore with source disposed; invalid records rejected. Small bounded cloud qualification after native proof. No new service subscription or paid upgrade. UI must retain the complete original command until reconciliation.

Verification: native focused tests, experiment typecheck, repository typecheck/guards, full financial suite on owned fresh MySQL 13326, independent read-only review and visual lab QA. Commit/push isolated session branch only; no main merge or production deployment.
