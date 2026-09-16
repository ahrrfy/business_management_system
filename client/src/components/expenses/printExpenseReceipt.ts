import { fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printDoc } from "@/lib/printing/print";
import { isExpenseFinanciallyPrintable } from "@/lib/expenseUiPolicy";
import {
  expenseCategoryText,
  fundingDetail,
  fundingKindOf,
  FUNDING_META,
  METHOD_LABEL,
  STATUS_LABEL,
  warningsOf,
  type ExpenseRow,
} from "./expenseView";

/** إيصال صرف عبر printDoc العام — نفس نواقل الطباعة الثلاثة (جسر الخادم/WebUSB/متصفح). */
export async function printExpenseReceipt(r: ExpenseRow) {
  if (r.source === "ACCRUAL") {
    notify.err(
      "المصروف المستحق ليس إيصال صرف؛ اطبع سند التسوية الفعلي من شاشة السندات بعد اعتماده",
    );
    return;
  }
  if (!isExpenseFinanciallyPrintable(r.status)) {
    notify.err("لا يمكن طباعة طلب مصروف غير منفذ كإيصال صرف");
    return;
  }
  const warnings = warningsOf(r);
  await printDoc({
    kind: "receipt",
    title: "الرؤية العربية",
    subtitle: "إيصال صرف — مصروف",
    meta: [
      `مصروف #${Number(r.id)}`,
      `التاريخ: ${r.expenseDate ? new Date(r.expenseDate as unknown as string).toISOString().slice(0, 10) : "—"}`,
      `الفرع: ${r.branchName ?? "—"}`,
      `الفئة: ${expenseCategoryText(r)}`,
      `طريقة الدفع: ${METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}`,
      `مصدر التمويل: ${FUNDING_META[fundingKindOf(r)].short} — ${fundingDetail(r)}`,
      ...(r.description ? [`البيان: ${r.description}`] : []),
      ...(r.payee ? [`المستفيد: ${r.payee}`] : []),
      ...(r.costCenter ? [`مركز التكلفة: ${r.costCenter}`] : []),
      ...(r.referenceNumber ? [`المرجع: ${r.referenceNumber}`] : []),
      ...(r.receiptVoucherNumber
        ? [`رقم السند: ${r.receiptVoucherNumber}`]
        : r.receiptId
          ? [`إيصال #${r.receiptId}`]
          : []),
      ...(r.createdByName ? [`أنشأ العملية: ${r.createdByName}`] : []),
      ...(r.approvedByName ? [`اعتمد العملية: ${r.approvedByName}`] : []),
      ...(r.createdAt
        ? [`سُجّلت: ${fmtDateTime(r.createdAt as unknown as string)}`]
        : []),
      ...(warnings.length ? [`ملاحظات التدقيق: ${warnings.join("؛ ")}`] : []),
      // إيصال مصروف مُلغى يحمل حالته صراحةً — لا يُقرأ كصرف نافذ بالخطأ.
      ...(r.status !== "ACTIVE"
        ? [`الحالة: ${STATUS_LABEL[r.status] ?? r.status}`]
        : []),
    ],
    totals: [{ label: "المبلغ", value: fmt(r.amount) }],
    footer: "إيصال صرف داخلي",
  });
}
