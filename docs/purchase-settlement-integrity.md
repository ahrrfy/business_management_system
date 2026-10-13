# Purchase payment evidence

Cash/credit on a purchase order describes the intended settlement method. Goods receipt and supplier invoice approval never prove that cash has been delivered.

The purchase list, drawer, full detail, supplier statement, print and export use one settlement result. For native invoices, actual paid amounts come from posted payment allocations less refunds, with verified legacy settlement evidence where applicable. Credit returns reduce the payable separately; they are not payments. Pending payment requests reserve capacity without changing paid amounts.

An inflated historical PO payment cache, or an ambiguous invoice covering multiple POs, requires reconciliation. The interface exposes this condition and prevents another payment. Existing receipts, journal entries, shifts, closures and handovers remain evidence; they must not be rewritten or balanced by invented transfers.

Generic supplier OUT vouchers cannot bypass native invoice allocation. This is checked at creation and again at approval. Native POs cannot be settled by guessing from an aggregate supplier balance. Trusted system settlements and genuine reversals retain their governed paths.

Run `node scripts/audit-purchase-settlement.mjs` against the configured database for a read-only inventory. It starts a consistent read-only transaction and reports native invoice cache drift separately from unpaid cash intent. It neither changes balances nor claims that an allocation gap proves physical nonpayment. Multiple-PO and legacy historical allocation evidence require their existing integrity workflow.

For an omitted real payment, first locate any existing receipt or allocation. If none exists, record the confirmed payment through `supplierPayments.requestPayment` with the actual cash source and an explicit evidence reference, then verify the receipt, journal, invoice allocation, PO projection, supplier balance and treasury effect together. Record when the correction was made; never invent the original payment date.
