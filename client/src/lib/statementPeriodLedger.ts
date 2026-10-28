import { fmtDate, toDate, type DateInput } from "./date";
import { D } from "./money";

type Movement = { t: number; debit: string | null; credit: string | null };

/** Period rows already come filtered by the server; imported opening is never a period movement. */
export function balanceStatementRows<T extends Movement>(
  movements: T[], openingBalance: string, kind: "customer" | "supplier",
) {
  let balance = D(openingBalance), totalDebit = D(0), totalCredit = D(0);
  const rows = [...movements].sort((a, b) => a.t - b.t).map(({ t: _t, ...row }) => {
    const debit = D(row.debit), credit = D(row.credit);
    balance = kind === "customer" ? balance.plus(debit).minus(credit) : balance.plus(credit).minus(debit);
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    return { ...row, balance: balance.toFixed(2) };
  });
  return { rows, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), closingBalance: balance.toFixed(2) };
}

/** The current party balance remains a separate disclosure, never a historical closing. */
export function statementClosingBalance(from: string, to: string, periodClosing: string, currentBalance: string): string {
  return from || to ? periodClosing : currentBalance;
}

type Actor = { createdBy?: number | null; createdByName?: string | null };
type CustomerInvoice = Actor & { invoiceDate: DateInput; invoiceNumber: string; status: string; total: string; ledgerTotal?: string };
type CustomerPayment = Actor & {
  createdAt: DateInput; voucherNumber?: string | null; paymentMethod?: string | null;
  isStandalone?: boolean; direction: string; amount: string;
};

export function customerStatementLedger(data: {
  invoices: CustomerInvoice[]; payments: CustomerPayment[]; summary: { openingBalance: string };
}) {
  const actor = (row: Actor) => row.createdByName ?? (row.createdBy ? `مستخدم #${row.createdBy}` : "غير موثق");
  // Historical invoice amounts and reversing movements must both remain in this ledger.
  const invoices = data.invoices.filter((row) => row.ledgerTotal != null ? !D(row.ledgerTotal).isZero() : row.status !== "CANCELLED").map((row) => ({
    t: (toDate(row.invoiceDate)?.getTime() ?? 0), date: fmtDate(row.invoiceDate),
    ref: row.invoiceNumber, description: "فاتورة مبيعات", actor: actor(row),
    debit: row.ledgerTotal ?? row.total, credit: null as string | null,
  }));
  const payments = data.payments.map((row) => ({
    t: (toDate(row.createdAt)?.getTime() ?? 0), date: fmtDate(row.createdAt),
    ref: row.voucherNumber ?? "دفعة", actor: actor(row),
    description: row.paymentMethod === "INVOICE_ADJUSTMENT" ? "تسوية ذمة الفاتورة دون حركة نقدية"
      : row.paymentMethod === "OPENING_ADJ" ? "تصحيح رصيد افتتاحي"
      : row.isStandalone ? (row.direction === "IN" ? "سند قبض مستقل" : "سند صرف مستقل")
      : row.direction === "IN" ? "دفعة وارد" : "استرداد",
    debit: row.direction === "OUT" ? row.amount : null,
    credit: row.direction === "IN" ? row.amount : null,
  }));
  const result = balanceStatementRows([...invoices, ...payments], data.summary.openingBalance, "customer");
  return { txs: result.rows, totDebit: result.totalDebit, totCredit: result.totalCredit, closingBalance: result.closingBalance };
}
