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

  const totalAmount = rows.reduce((acc, r) => acc.plus(D(r.amount)), D(0));
  const overdueCount = rows.filter((r) => r.daysOverdue > 0).length;

  return printFn({
    title: `طابور تحصيل الأقساط المستحقة — خلال ${days} يوماً`,
    docDate: fmtDate(new Date()),
    headerExtra: [
      { label: "عدد الأقساط", value: String(rows.length) },
      { label: "الأقساط المتأخرة", value: String(overdueCount) },
    ],
    columns: [
      { key: "customer", label: "العميل", align: "right" },
      { key: "phone", label: "الهاتف", align: "right" },
      { key: "planSeq", label: "الخطة / القسط", align: "center" },
      { key: "dueDate", label: "تاريخ الاستحقاق", align: "center" },
      { key: "overdue", label: "حالة التأخر", align: "center" },
      { key: "amount", label: "المبلغ (د.ع)", align: "left" },
      { key: "kind", label: "طريقة السداد", align: "center" },
    ],
    rows: rows.map((r) => ({
      customer: r.customerName,
      phone: r.customerPhone ?? "—",
      planSeq: `خطة #${r.planId} (قسط ${r.seq})`,
      dueDate: r.dueDate,
      overdue: r.daysOverdue > 0 ? `متأخر ${r.daysOverdue} يوماً` : "في الموعد",
      amount: `${fmt(r.amount)} د.ع`,
      kind: r.kind === "CHECK" ? `صك ${r.checkNumber ?? ""}` : "نقدي",
    })),
    summary: [
      {
        label: "إجمالي المبالغ المستحقة",
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
    docDate: fmtDate(new Date()),
    headerExtra: [
      { label: "العميل", value: plan.customerName },
      { label: "إجمالي الخطة", value: `${fmt(plan.totalAmount)} د.ع` },
      { label: "الدفعة الأولى", value: `${fmt(plan.downPayment)} د.ع` },
      ...(plan.invoiceId != null ? [{ label: "الفاتورة المرتبطة", value: `#${plan.invoiceId}` }] : []),
    ],
    columns: [
      { key: "seq", label: "القسط", align: "center" },
      { key: "dueDate", label: "تاريخ الاستحقاق", align: "center" },
      { key: "amount", label: "المبلغ", align: "left" },
      { key: "kind", label: "النوع", align: "center" },
      { key: "status", label: "الحالة", align: "center" },
      { key: "notes", label: "ملاحظات", align: "right" },
    ],
    rows: (plan.lines ?? []).map((l) => ({
      seq: `القسط ${l.seq}`,
      dueDate: l.dueDate,
      amount: `${fmt(l.amount)} د.ع`,
      kind: l.kind === "CHECK" ? `صك ${l.checkNumber ?? ""}` : "نقدي",
      status: LINE_STATUS_AR[l.status]?.label ?? l.status,
      notes: l.note ?? "—",
    })),
    summary: [
      { label: "إجمالي الخطة", value: `${fmt(plan.totalAmount)} د.ع`, bold: true },
      { label: "الدفعة الأولى", value: `${fmt(plan.downPayment)} د.ع` },
      { label: "المتبقي بالأقساط", value: `${fmt(D(plan.totalAmount).minus(D(plan.downPayment)).toFixed(2))} د.ع`, bold: true, large: true },
    ],
    showIndex: true,
  });
}
