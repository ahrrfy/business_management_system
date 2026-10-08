/** Cache dependencies only: events never carry balances, receipts or customer data. */
export const FINANCIAL_ALERTS_REFRESH_MS = 30_000;

export const FINANCIAL_QUERY_ROOTS = [
  "treasury", "shifts", "cashTransfers", "cashRemediation", "accounts", "reports",
  "statutoryAccounting", "executive", "decisions", "sales", "salesControl",
  "purchases", "purchaseReturns", "purchaseReturnGovernance", "purchaseIntegrity",
  "supplierPayments", "purchaseCharges", "goodsReceiptReversal", "supplierInvoiceApproval",
  "returns", "customers", "suppliers", "vouchers", "voucherCategories", "expenses", "expenseCategories", "installments",
  "commissions", "payroll", "employees", "hrEnterprise", "attendance", "assets", "exchange", "cardAccount",
  "digitalCards", "delivery", "courier", "consignments", "reception", "workOrders",
  "printPos", "printAudit", "reservations", "yearEnd", "periodLock", "offline",
] as const;

const financialMutations: ReadonlySet<string> = new Set([
  ...FINANCIAL_QUERY_ROOTS, "offline", "inventory", "stocktakes", "count",
  "production", "gifts", "imports", "storeAdmin", "storefront", "promotions", "leaves",
]);

/** Includes pending/lifecycle changes which legitimately create no ledger entry. */
export function isFinancialMutation(path: string): boolean {
  return financialMutations.has(path.split(".")[0]);
}

export interface FinancialDataChangedPayload {
  /** null = company-wide change; otherwise only the listed branches changed. */
  branchIds: number[] | null;
}
