import { fmtDate, toDate, type DateInput } from "./date";
import { D } from "./money";
import { isUnifiedPaymentMethod, paymentMethodCompact } from "@shared/terms";

type Movement = { t: number; debit: string | null; credit: string | null };

const pad2 = (n: number) => String(n).padStart(2, "0");
export const localYmd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function getStatementPeriodPresets(allowAllEmpty = true) {
  return [
    { key: "today", label: "اليوم", get: () => { const t = localYmd(new Date()); return { from: t, to: t }; } },
    {
      key: "7d",
      label: "آخر 7 أيام",
      get: () => {
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 6);
        return { from: localYmd(start), to: localYmd(end) };
      },
    },
    {
      key: "mtd",
      label: "هذا الشهر",
      get: () => { const n = new Date(); return { from: localYmd(new Date(n.getFullYear(), n.getMonth(), 1)), to: localYmd(n) }; },
    },
    {
      key: "lastMonth",
      label: "الشهر الماضي",
      get: () => { const n = new Date(); return { from: localYmd(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: localYmd(new Date(n.getFullYear(), n.getMonth(), 0)) }; },
    },
    {
      key: "all",
      label: "منذ البداية",
      get: () => (allowAllEmpty ? { from: "", to: "" } : { from: "2020-01-01", to: localYmd(new Date()) }),
    },
  ];
}

export function sumStatementMoneyCol(values: (string | null | undefined)[]): ReturnType<typeof D> {
  return values.reduce((acc, v) => (v ? acc.plus(D(v)) : acc), D(0));
}

export function statementMethodDisplayLabel(method: string | null | undefined): string {
  if (method === "COD") return "تحصيل مندوب";
  if (method === "RETURN") return "مرتجع";
  if (method === "OPENING_ADJ") return "تصحيح افتتاحي";
  if (method === "INVOICE_ADJUSTMENT") return "تسوية ذمة الفاتورة";
  if (method === "CHARGE_ADJUSTMENT") return "أجر تنفيذ";
  if (isUnifiedPaymentMethod(method)) return paymentMethodCompact(method);
  return method ?? "—";
}

/** عزل الأرقام والمدى الرقمي (`0–30`, `+90`, `$100`) دون تطبيق `dir="ltr"` على الجملة العربية. */
export function splitBidiTokens(text: string): Array<{ text: string; ltr: boolean }> {
  if (!text) return [];
  const re = /(\$?\+?\d[\d,]*(?:[–-]\d[\d,]*)?(?:\.\d+)?)/g;
  const out: Array<{ text: string; ltr: boolean }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const idx = m.index;
    if (idx > last) out.push({ text: text.slice(last, idx), ltr: false });
    out.push({ text: m[0], ltr: true });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), ltr: false });
  return out;
}

/** Period rows already come filtered by the server; imported opening is never a period movement. */
export function balanceStatementRows<T extends Movement>(
  movements: T[], openingBalance: string, kind: "customer" | "supplier",
) {
  let balance = D(openingBalance), totalDebit = D(0), totalCredit = D(0);
  const rows = [...movements].sort((a, b) => a.t - b.t).map(({ t: _t, ...row }) => {
    const balanceBefore = balance;
    const debit = D(row.debit), credit = D(row.credit);
    balance = kind === "customer" ? balance.plus(debit).minus(credit) : balance.plus(credit).minus(debit);
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    return { ...row, balanceBefore: balanceBefore.toFixed(2), balance: balance.toFixed(2) };
  });
  return { rows, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), closingBalance: balance.toFixed(2) };
}

/** The current party balance remains a separate disclosure, never a historical closing. */
export function statementClosingBalance(from: string, to: string, periodClosing: string, currentBalance: string): string {
  return from || to ? periodClosing : currentBalance;
}

export interface StatementLineItem {
  productName: string;
  unitName?: string | null;
  quantity: string | number;
  unitPrice: string | number;
  total: string | number;
}

export type StatementMovementKind =
  | "SALE"
  | "RETURN"
  | "COD"
  | "PAYMENT_IN"
  | "PAYMENT_OUT"
  | "ADJUSTMENT"
  | "FULFILLMENT_CHARGE"
  | "OPENING";

type Actor = { createdBy?: number | null; createdByName?: string | null };
type CustomerInvoice = Actor & {
  id?: number;
  invoiceDate: DateInput;
  invoiceNumber: string;
  status: string;
  sourceType?: string | null;
  paymentMethod?: string | null;
  paymentMode?: string | null;
  total: string;
  ledgerTotal?: string;
  paidAmount?: string;
  returnedTotal?: string;
  remainingAmount?: string;
  items?: StatementLineItem[];
};
type CustomerPayment = Actor & {
  id?: number;
  createdAt: DateInput;
  voucherNumber?: string | null;
  paymentMethod?: string | null;
  cashBucket?: string | null;
  cardLastFour?: string | null;
  invoiceId?: number | null;
  invoiceNumber?: string | null;
  description?: string | null;
  status?: string | null;
  isStandalone?: boolean;
  direction: string;
  amount: string;
};

export interface CustomerLedgerRow {
  rowKey: string;
  date: string;
  ref: string;
  description: string;
  kind: StatementMovementKind;
  actor: string;
  debit: string | null;
  credit: string | null;
  balanceBefore: string;
  balance: string;
  invoiceId?: number;
  receiptId?: number;
  paymentMethod?: string | null;
  cashBucket?: string | null;
  cardLastFour?: string | null;
  status?: string | null;
  sourceType?: string | null;
  paidAmount?: string;
  returnedAmount?: string;
  remainingAmount?: string;
  openHref?: string;
  items?: StatementLineItem[];
}

export function customerStatementLedger(data: {
  invoices: CustomerInvoice[]; payments: CustomerPayment[]; summary: { openingBalance: string };
}) {
  const actor = (row: Actor) => row.createdByName ?? (row.createdBy ? `مستخدم #${row.createdBy}` : "غير موثق");
  // Historical invoice amounts and reversing movements must both remain in this ledger.
  const invoices = data.invoices
    .filter((row) => row.ledgerTotal != null ? !D(row.ledgerTotal).isZero() : row.status !== "CANCELLED")
    .map((row, idx) => ({
      t: (toDate(row.invoiceDate)?.getTime() ?? 0),
      rowKey: row.id != null ? `inv-${row.id}` : `inv-${row.invoiceNumber}-${idx}`,
      date: fmtDate(row.invoiceDate),
      ref: row.invoiceNumber,
      description: "فاتورة مبيعات",
      kind: "SALE" as StatementMovementKind,
      actor: actor(row),
      debit: row.ledgerTotal ?? row.total,
      credit: null as string | null,
      invoiceId: row.id,
      receiptId: undefined as number | undefined,
      paymentMethod: row.paymentMethod ?? (row.paymentMode === "COD" ? "COD" : null),
      cashBucket: null as string | null,
      cardLastFour: null as string | null,
      status: row.status,
      sourceType: row.sourceType ?? null,
      paidAmount: row.paidAmount,
      returnedAmount: row.returnedTotal,
      remainingAmount: row.remainingAmount,
      openHref: row.id != null ? `/invoices/${row.id}` : undefined,
      items: row.items,
    }));

  const payments = data.payments.map((row, idx) => {
    const pm = row.paymentMethod;
    let kind: StatementMovementKind;
    let description: string;
    if (pm === "INVOICE_ADJUSTMENT") {
      kind = "ADJUSTMENT";
      description = "تسوية ذمة الفاتورة دون حركة نقدية";
    } else if (pm === "OPENING_ADJ") {
      kind = "OPENING";
      description = "تصحيح رصيد افتتاحي";
    } else if (pm === "RETURN") {
      kind = "RETURN";
      description = "مرتجع مبيعات";
    } else if (pm === "COD") {
      kind = "COD";
      description = row.invoiceNumber ? `تحصيل مندوب (${row.invoiceNumber})` : "تحصيل مندوب";
    } else if (pm === "CHARGE_ADJUSTMENT") {
      kind = "FULFILLMENT_CHARGE";
      description = row.description ?? "مطالبة أو عكس أجر تنفيذ";
    } else if (row.isStandalone) {
      kind = row.direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT";
      description = row.direction === "IN" ? "سند قبض مستقل" : "سند صرف مستقل";
    } else if (row.direction === "IN") {
      kind = "PAYMENT_IN";
      description = row.invoiceNumber ? `سند قبض (${row.invoiceNumber})` : "سند قبض";
    } else {
      kind = "PAYMENT_OUT";
      description = row.invoiceNumber ? `استرداد (${row.invoiceNumber})` : "استرداد للعميل";
    }

    return {
      t: (toDate(row.createdAt)?.getTime() ?? 0),
      rowKey: row.id != null ? `pay-${row.id}-${idx}` : `pay-${idx}`,
      date: fmtDate(row.createdAt),
      ref: row.voucherNumber ?? (row.invoiceNumber ? `INV-${row.invoiceNumber.replace(/^INV-/, "")}` : "حركة"),
      description,
      kind,
      actor: actor(row),
      debit: row.direction === "OUT" ? row.amount : null,
      credit: row.direction === "IN" ? row.amount : null,
      invoiceId: row.invoiceId ?? undefined,
      receiptId: row.id != null && row.id > 0 ? row.id : undefined,
      paymentMethod: row.paymentMethod ?? null,
      cashBucket: row.cashBucket ?? null,
      cardLastFour: row.cardLastFour ?? null,
      status: row.status ?? null,
      sourceType: null as string | null,
      paidAmount: undefined as string | undefined,
      returnedAmount: undefined as string | undefined,
      remainingAmount: undefined as string | undefined,
      openHref: pm === "CHARGE_ADJUSTMENT"
        ? "/delivery?tab=fulfillment&kind=charges"
        : row.invoiceId != null && row.invoiceId > 0
          ? `/invoices/${row.invoiceId}`
          : undefined,
      items: undefined as StatementLineItem[] | undefined,
    };
  });

  const result = balanceStatementRows([...invoices, ...payments], data.summary.openingBalance, "customer");
  return { txs: result.rows, totDebit: result.totalDebit, totCredit: result.totalCredit, closingBalance: result.closingBalance };
}
