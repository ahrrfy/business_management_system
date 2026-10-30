import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmt, D } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import type { DueRow, PlanDetail } from "./installmentTypes";
import { LINE_STATUS_AR } from "./installmentTypes";

/**
 * طباعة رسمية لطابور تحصيل الأقساط المستحقة قريباً.
 */
export function printDueSoonReport(
  inputOrRows: { rows: DueRow[]; days: number } | DueRow[],
  maybeDays?: number | ((doc: any) => boolean),
  maybePrintFn?: (doc: any) => boolean,
): boolean {
  const rows = Array.isArray(inputOrRows) ? inputOrRows : inputOrRows.rows;
  const days = Array.isArray(inputOrRows)
    ? typeof maybeDays === "number"
      ? maybeDays
      : 7
    : inputOrRows.days;
  const printFn =
    typeof maybeDays === "function"
      ? maybeDays
      : maybePrintFn ?? printReportDoc;

  const totalAmount = rows.reduce((acc, r) => acc.plus(D(r.remainingAmount)), D(0));
  const overdueCount = rows.filter((r) => r.daysOverdue > 0).length;

  return printFn({
    title: `طابور تحصيل الأقساط المستحقة — خلال ${days} يوماً`,
    orientation: "landscape",
    docDate: fmtDate(new Date()),
    headerExtra: [
      { label: "عدد الأقساط", value: String(rows.length) },
      { label: "الأقساط المتأخرة", value: String(overdueCount) },
    ],
    columns: [
      { key: "customer", label: "العميل", align: "right", width: "240px" },
      { key: "phone", label: "الهاتف", align: "right", width: "120px" },
      { key: "planSeq", label: "الخطة / القسط", align: "center", width: "105px" },
      { key: "dueDate", label: "تاريخ الاستحقاق", align: "center", width: "95px" },
      { key: "overdue", label: "حالة التأخر", align: "center", width: "130px" },
      { key: "amount", label: "المبلغ (د.ع)", align: "left", width: "150px" },
      { key: "kind", label: "طريقة السداد", align: "center", width: "150px" },
    ],
    rows: rows.map((r) => ({
      customer: r.customerName,
      phone: r.customerPhone ?? "—",
      planSeq: `خطة #${r.planId} (قسط ${r.seq})`,
      dueDate: r.dueDate,
      overdue: [r.reconciliationRequired ? "تحتاج مطابقة" : null, r.pendingApproval ? "بانتظار اعتماد السند" : null].filter(Boolean).join(" — ")
        || (r.daysOverdue > 0 ? `متأخر ${r.daysOverdue} يوماً` : "في الموعد"),
      amount: `${fmt(r.remainingAmount)} د.ع`,
      kind: r.kind === "CHECK" ? `صك ${r.checkNumber ?? ""}` : "نقدي",
    })),
    summary: [
      {
        label: "إجمالي المتبقي حسب السجل الموثق",
        value: `${fmt(totalAmount.toFixed(2))} د.ع`,
        bold: true,
        large: true,
      },
    ],
    showIndex: true,
  });
}

/**
 * طباعة رسمية لجدول أقساط خطة محددة.
 */
export function printPlanScheduleReport(
  inputOrPlan: { plan: PlanDetail } | PlanDetail,
  printFn: (doc: any) => boolean = printReportDoc,
): boolean {
  const plan = "plan" in inputOrPlan ? inputOrPlan.plan : inputOrPlan;
  return printFn({
    title: `جدول سداد خطة الأقساط #${plan.id}`,
    orientation: "landscape",
    docDate: fmtDate(new Date()),
    headerExtra: [
      { label: "العميل", value: plan.customerName },
      { label: "إجمالي الخطة", value: `${fmt(plan.totalAmount)} د.ع` },
      { label: "صافي المدفوع بالفاتورة", value: fmt(plan.invoiceNetPaidAmount ?? "0") },
      { label: "المتبقي الفعلي بالفاتورة", value: plan.invoiceRemainingAmount == null ? "—" : fmt(plan.invoiceRemainingAmount) },
      ...(plan.reconciliationRequired ? [{ label: "المطابقة", value: "تحتاج مطابقة السندات مع الفاتورة؛ مبالغ الجدول تمثل السجل الموثق" }] : []),
      { label: "الدفعة الأولى", value: `${fmt(plan.downPayment)} د.ع` },
      ...(plan.invoiceId != null ? [{ label: "الفاتورة المرتبطة", value: `#${plan.invoiceId}` }] : []),
    ],
    columns: [
      { key: "seq", label: "القسط", align: "center", width: "65px" },
      { key: "dueDate", label: "تاريخ الاستحقاق", align: "center", width: "85px" },
      { key: "amount", label: "المجدول", align: "left", width: "140px" },
      { key: "paid", label: "المحصّل الموثق", align: "left", width: "140px" },
      { key: "remaining", label: "المتبقي", align: "left", width: "140px" },
      { key: "kind", label: "النوع", align: "center", width: "70px" },
      { key: "status", label: "الحالة", align: "center", width: "100px" },
      { key: "receipts", label: "السندات / أثر التخصيص", align: "right", width: "200px" },
      { key: "notes", label: "ملاحظات", align: "right", width: "90px" },
    ],
    rows: (plan.lines ?? []).map((l) => ({
      seq: `القسط ${l.seq}`,
      dueDate: l.dueDate,
      amount: fmt(l.amount), paid: fmt(l.paidAmount), remaining: fmt(l.remainingAmount),
      kind: l.kind === "CHECK" ? `صك ${l.checkNumber ?? ""}` : "نقدي",
      status: l.reconciliationRequired ? "تحتاج مطابقة" : l.pendingApproval ? "بانتظار الاعتماد" : LINE_STATUS_AR[l.status]?.label ?? l.status,
      receipts: l.paymentHistory.map(r => "#" + (r.voucherNumber ?? r.receiptId) + ": " + fmt(r.effectAmount) + (r.reversed ? " (معكوس)" : "")).join("؛ ") || "—",
      notes: l.note ?? "—",
    })),
    summary: [
      { label: "إجمالي الخطة", value: `${fmt(plan.totalAmount)} د.ع`, bold: true },
      { label: "الدفعة الأولى", value: `${fmt(plan.downPayment)} د.ع` },
      { label: "المتبقي بالأقساط", value: `${fmt(plan.lines.reduce((sum, line) => sum.plus(line.remainingAmount), D(0)).toFixed(2))} د.ع`, bold: true, large: true },
    ],
    showIndex: false,
  });
}
