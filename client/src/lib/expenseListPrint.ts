import { D, fmt } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { printReportDoc } from "@/lib/printing/reportDoc";
import {
  expenseCategoryText,
  fundingDetail,
  fundingKindOf,
  FUNDING_META,
  sourceLabel,
  STATUS_LABEL,
  warningsOf,
  type AuditFocus,
  type ExpenseRow,
} from "@/components/expenses/expenseView";
export function printExpenseRows(
  printable: readonly ExpenseRow[],
  filterLabels: string,
  audit: { auditFocus: AuditFocus | null; auditOnly: boolean },
) {
  const auditLabel = audit.auditFocus
    ? "استثناء: " +
      {
        DESCRIPTION: "بلا شرح",
        PAYEE: "بلا مستفيد",
        SOURCE: "مصدر أو إيصال غير متطابق",
        DRAWER: "درج أو وردية ناقصة",
      }[audit.auditFocus]
    : audit.auditOnly
      ? "يحتاج تدقيقاً"
      : null;
  filterLabels = [filterLabels, auditLabel].filter(Boolean).join(" · ");
  const printTotal = printable.reduce(
    (sum, row) => sum.plus(D(row.amount)),
    D(0),
  );
  return printReportDoc({
    title: "المصروفات اليومية",
    headerExtra: filterLabels
      ? [{ label: "الفلاتر", value: filterLabels }]
      : [],
    columns: [
      { key: "identity", label: "المصروف / السند" },
      { key: "date", label: "التاريخ / التسجيل" },
      { key: "branch", label: "الفرع" },
      { key: "category", label: "الفئة / المركز" },
      { key: "description", label: "البيان / المستفيد" },
      { key: "funding", label: "التمويل / الدفع" },
      { key: "shift", label: "الدرج / الوردية" },
      { key: "actors", label: "المنشئ / المعتمد" },
      { key: "amount", label: "المبلغ", align: "left" },
      { key: "status", label: "الحالة" },
      { key: "audit", label: "ملاحظات التدقيق" },
    ],
    rows: printable.map((r) => ({
      identity: `#${Number(r.id)}${r.receiptVoucherNumber ? ` / ${r.receiptVoucherNumber}` : r.receiptId ? ` / R#${r.receiptId}` : ""}`,
      date: `${fmtDate(r.expenseDate as unknown as string)} / ${fmtDateTime(r.createdAt as unknown as string)}`,
      branch: r.branchName ?? "—",
      category: `${expenseCategoryText(r)}${r.costCenter?.trim() ? ` / ${r.costCenter.trim()}` : ""}`,
      description: `${r.description ?? "لا يوجد شرح"}${r.payee ? ` / المستفيد: ${r.payee}` : ""}${r.referenceNumber ? ` / مرجع: ${r.referenceNumber}` : ""}`,
      funding: `${FUNDING_META[fundingKindOf(r)].short} / ${sourceLabel(r)}`,
      shift: fundingDetail(r),
      actors: `${r.createdByName ?? (r.createdBy != null ? `#${r.createdBy}` : "—")}${r.approvedByName ? ` / اعتماد: ${r.approvedByName}` : ""}`,
      amount: fmt(r.amount),
      status: STATUS_LABEL[r.status] ?? r.status,
      audit: warningsOf(r).join("؛ ") || "سليم",
    })),
    summary: [
      {
        label: "إجمالي المصروفات النافذة فقط",
        value: `${fmt(printTotal.toString())} د.ع`,
        large: true,
        bold: true,
      },
    ],
  });
}
