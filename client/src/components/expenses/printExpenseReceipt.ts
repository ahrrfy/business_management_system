import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import { printDoc } from "@/lib/printing/print";
import type { PrintWindowOptions } from "@/lib/printing/brand";
import { formatArabicMoneyWords } from "@/lib/printing/tafqit";
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
export async function printExpenseReceipt(r: ExpenseRow, options?: PrintWindowOptions) {
  if (r.source === "ACCRUAL") {
    try { options?.into?.close(); } catch { /* ignore */ }
    notify.err(
      "المصروف المستحق ليس إيصال صرف؛ اطبع سند التسوية الفعلي من شاشة السندات بعد اعتماده",
    );
    return;
  }
  if (!isExpenseFinanciallyPrintable(r.status)) {
    try { options?.into?.close(); } catch { /* ignore */ }
    notify.err("لا يمكن طباعة طلب مصروف غير منفذ كإيصال صرف");
    return;
  }
  let expenseDateStr = "—";
  if (r.expenseDate) {
    try {
      const parsed = new Date(r.expenseDate as unknown as string | Date);
      expenseDateStr = Number.isNaN(parsed.getTime()) ? "—" : fmtDate(parsed);
    } catch {
      expenseDateStr = "—";
    }
  }
  const warnings = warningsOf(r);
  await printDoc({
    kind: "receipt",
    title: "الرؤية العربية",
    subtitle: "إيصال صرف — مصروف",
    meta: [
      `مصروف #${r.id}`,
      `التاريخ: ${expenseDateStr}`,
      `الفرع: ${r.branchName ?? "—"}`,
      `الفئة: ${expenseCategoryText(r)}`,
      `طريقة الدفع: ${METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}`,
      `مصدر التمويل: ${FUNDING_META[fundingKindOf(r)].short} — ${fundingDetail(r)}`,
      ...(r.description?.trim() ? [`البيان: ${r.description.trim()}`] : []),
      ...(r.payee?.trim() ? [`المستفيد: ${r.payee.trim()}`] : []),
      ...(r.costCenter?.trim() ? [`مركز التكلفة: ${r.costCenter.trim()}`] : []),
      ...(r.referenceNumber?.trim() ? [`المرجع: ${r.referenceNumber.trim()}`] : []),
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
    totals: [
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(r.amount) },
      { label: "المبلغ", value: `${fmt(r.amount)} د.ع` },
    ],
    footer: "إيصال صرف داخلي",
  }, options);
}
