import { D, round2 } from "@/lib/money";

export const PETTY_CASH_LIMIT_IQD = "500000";

export type ExpenseExecutionMode =
  | "STOCK_IMMEDIATE"
  | "DRAWER_IMMEDIATE"
  | "PENDING_OWNER_APPROVAL";

/** الطلب/الرفض ليسا إيصال صرف؛ الطباعة المالية تبدأ بعد ACTIVE فقط. */
export function isExpenseFinanciallyPrintable(status: string): boolean {
  return status === "ACTIVE";
}

function auditObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** يعرض قرار الرفض لصاحب الطلب بدلاً من إخفائه خلف وصف تدقيقي عام. */
export function expenseAuditDetail(
  action: string,
  oldValue: unknown,
  newValue: unknown,
): string | undefined {
  if (action === "expense.reject") {
    const reason = auditObject(newValue)?.rejectionReason;
    if (typeof reason === "string" && reason.trim()) {
      return `سبب الرفض: ${reason.trim()}`;
    }
  }
  return oldValue != null || newValue != null
    ? "تغيير موثق في سجل التدقيق"
    : undefined;
}

export function expenseApprovalExecutionText(paymentMethod: string): string {
  return paymentMethod === "CASH"
    ? "عند الاعتماد يُصرف المبلغ من خزينة الفرع."
    : "عند الاعتماد يُنفذ بطريقة الدفع المختارة خارج رصيد الدرج والخزينة النقدية.";
}

const EXPENSE_STATUS_FILTERS = new Set([
  "PENDING_APPROVAL",
  "ACTIVE",
  "REJECTED",
  "CANCELLED",
]);

/** روابط مركز الاعتمادات تفتح الطابور المطلوب، مع allowlist تمنع حقن قيمة غريبة. */
export function expenseStatusFromSearch(search: string): string {
  const status = new URLSearchParams(search).get("status") ?? "";
  return EXPENSE_STATUS_FILTERS.has(status) ? status : "";
}

/** مرآة عرض فقط؛ القرار الحاكم يُعاد حسابه دائماً في خدمة الخادم. */
export function expenseExecutionMode(input: {
  source: "CASH" | "INTERNAL_USE" | "WASTAGE";
  amount: string;
  paymentMethod: string;
  cashSource: "OWN_DRAWER" | "TREASURY";
}): ExpenseExecutionMode {
  if (input.source !== "CASH") return "STOCK_IMMEDIATE";
  const needsApproval =
    input.paymentMethod !== "CASH" ||
    round2(D(input.amount || 0)).gte(PETTY_CASH_LIMIT_IQD) ||
    input.cashSource === "TREASURY";
  if (needsApproval) return "PENDING_OWNER_APPROVAL";
  return "DRAWER_IMMEDIATE";
}
