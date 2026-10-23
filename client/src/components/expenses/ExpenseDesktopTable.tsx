import { Fragment } from "react";
import { Building2, ChevronDown, ChevronUp, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TableEmptyRow } from "@/components/PageState";
import { RowActions, type RowAction } from "@/components/list";
import { FinancialCellProvenanceHover } from "@/components/financial";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { fmt } from "@/lib/money";
import { ExpenseTracePanel } from "./ExpenseTracePanel";
import {
  APPROVAL_LABEL,
  expenseCategoryText,
  fundingDetail,
  fundingKindOf,
  FUNDING_META,
  isApprovedAwaitingExecution,
  SHIFT_STATUS_LABEL,
  SHIFT_TYPE_LABEL,
  sourceLabel,
  STATUS_CLS,
  STATUS_LABEL,
  type ExpenseRow,
} from "./expenseView";
export type ExpenseViewEntry = {
  row: ExpenseRow;
  warnings: string[];
  funding: ReturnType<typeof fundingKindOf>;
};
export interface ExpenseDesktopTableProps {
  groupedRows: {
    kind: ExpenseViewEntry["funding"];
    entries: ExpenseViewEntry[];
  }[];
  rowProps: (id: number | string | null | undefined) => {
    ref?: (element: HTMLElement | null) => void;
    className: string;
  };
  expandedDescriptions: ReadonlySet<number>;
  expandedTraces: ReadonlySet<number>;
  toggleDescription: (id: number) => void;
  toggleTrace: (id: number) => void;
  actionsFor: (row: ExpenseRow) => RowAction[];
  canTrace: boolean;
  loaded: boolean;
  visibleCount: number;
  auditOnly: boolean;
  query: string;
}
export function ExpenseDesktopTable({
  groupedRows,
  rowProps,
  expandedDescriptions,
  expandedTraces,
  toggleDescription,
  toggleTrace,
  actionsFor,
  canTrace,
  loaded,
  visibleCount,
  auditOnly,
  query,
}: ExpenseDesktopTableProps) {
  return (
    <div className="hidden md:block">
      <ScrollTableShell
        bordered={false}
        maxHeightClass="max-h-[calc(100dvh-13rem)]"
      >
        <table className="w-full min-w-[1500px] text-sm">
          <caption className="sr-only">
            سجل المصروفات التفصيلي مجمّع حسب مصدر التمويل
          </caption>
          <thead className="bg-muted/50">
            <tr>
              <th scope="col" className="p-2 text-start">
                المصروف / السند
              </th>
              <th scope="col" className="p-2 text-start">
                التاريخ والتوقيت
              </th>
              <th scope="col" className="p-2 text-start">
                البيان / المستفيد
              </th>
              <th scope="col" className="p-2 text-start">
                الفرع / التصنيف
              </th>
              <th scope="col" className="p-2 text-start">
                مصدر التمويل
              </th>
              <th scope="col" className="p-2 text-start">
                الدرج / الوردية
              </th>
              <th scope="col" className="p-2 text-start">
                المسؤولية والاعتماد
              </th>
              <th scope="col" className="p-2 text-start">
                المبلغ
              </th>
              <th scope="col" className="p-2 text-start">
                الحالة
              </th>
              <th scope="col" className="p-2 text-start">
                التدقيق
              </th>
              <th scope="col" className="p-2 text-center">
                إجراء
              </th>
            </tr>
          </thead>
          <tbody>
            {groupedRows.map((group) => (
              <Fragment key={group.kind}>
                <tr className="border-y bg-muted/70">
                  <td colSpan={11} className="px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">
                        {FUNDING_META[group.kind].label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {group.entries.length} عملية · إجمالي الصفحة{" "}
                        <span
                          className="font-semibold text-foreground tabular-nums"
                          dir="ltr"
                        >
                          {fmt(
                            group.entries.reduce(
                              (sum, entry) => sum + Number(entry.row.amount),
                              0,
                            ),
                          )}
                        </span>
                      </span>
                    </div>
                  </td>
                </tr>
                {group.entries.map(({ row: r, warnings, funding }) => {
                  const fr = rowProps(r.id);
                  const expanded = expandedDescriptions.has(Number(r.id));
                  const traceExpanded = expandedTraces.has(Number(r.id));
                  return (
                    <Fragment key={Number(r.id)}>
                      <tr
                        ref={fr.ref}
                        className={`border-t align-top ${fr.className} ${r.status === "CANCELLED" ? "opacity-70" : ""}`}
                      >
                        <td className="p-2">
                          <div className="font-mono text-xs" dir="ltr">
                            EXP#{Number(r.id)}
                          </div>
                          <div
                            className="mt-1 font-mono text-[11px] text-muted-foreground"
                            dir="ltr"
                          >
                            {r.receiptVoucherNumber ??
                              (r.receiptId ? `R#${r.receiptId}` : "بلا سند")}
                          </div>
                          {r.referenceNumber && (
                            <div
                              className="mt-1 max-w-36 truncate text-[11px] text-muted-foreground"
                              title={r.referenceNumber}
                            >
                              مرجع: {r.referenceNumber}
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-xs">
                          <div dir="ltr">
                            {fmtDate(r.expenseDate as unknown as string)}
                          </div>
                          <div
                            className="mt-1 text-[11px] text-muted-foreground"
                            dir="ltr"
                          >
                            أُدخل:{" "}
                            {fmtDateTime(r.createdAt as unknown as string)}
                          </div>
                          {r.updatedAt && (
                            <div
                              className="text-[11px] text-muted-foreground"
                              dir="ltr"
                            >
                              حُدّث: {fmtDateTime(r.updatedAt)}
                            </div>
                          )}
                        </td>
                        <td className="max-w-[25rem] p-2">
                          <p
                            className={`leading-6 ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
                          >
                            {r.description?.trim() || (
                              <span className="font-medium text-destructive">
                                لا يوجد شرح للعملية
                              </span>
                            )}
                          </p>
                          {(r.description?.length ?? 0) > 80 && (
                            <button
                              type="button"
                              className="mt-1 text-xs text-primary underline-offset-4 hover:underline"
                              onClick={() => toggleDescription(Number(r.id))}
                            >
                              {expanded ? "طي" : "عرض كامل"}
                            </button>
                          )}
                          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                            <UserRound aria-hidden className="size-3.5" />{" "}
                            المستفيد:{" "}
                            <span className="text-foreground">
                              {r.payee ?? "—"}
                            </span>
                          </div>
                        </td>
                        <td className="p-2 text-xs">
                          <div>{r.branchName ?? "—"}</div>
                          <div className="mt-1 text-muted-foreground">
                            {expenseCategoryText(r)}
                          </div>
                          {r.costCenter?.trim() && (
                            <div className="text-[11px] text-muted-foreground">
                              مركز: {r.costCenter.trim()}
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-xs">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs ${FUNDING_META[funding].badge}`}
                            title={
                              funding === "PENDING"
                                ? "الوضع الراهن: طلب معلّق بلا أثر مالي حتى الآن"
                                : undefined
                            }
                          >
                            {FUNDING_META[funding].short}
                          </span>
                          <div className="mt-1 text-muted-foreground">
                            {sourceLabel(r)}
                          </div>
                        </td>
                        <td className="p-2 text-xs">
                          {funding === "DRAWER" ? (
                            <>
                              <div className="font-medium">
                                {r.shiftOwnerName ?? "صاحب الدرج غير ظاهر"}
                              </div>
                              <div
                                className="mt-1 text-muted-foreground"
                                dir="ltr"
                              >
                                وردية #{r.shiftId ?? "—"}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {r.shiftType
                                  ? (SHIFT_TYPE_LABEL[r.shiftType] ??
                                    r.shiftType)
                                  : "—"}{" "}
                                ·{" "}
                                {r.shiftStatus
                                  ? (SHIFT_STATUS_LABEL[r.shiftStatus] ??
                                    r.shiftStatus)
                                  : "—"}
                              </div>
                            </>
                          ) : funding === "TREASURY" ? (
                            <div className="inline-flex items-center gap-1">
                              <Building2 aria-hidden className="size-4" />{" "}
                              الخزينة الإدارية
                            </div>
                          ) : (
                            <div>{fundingDetail(r)}</div>
                          )}
                        </td>
                        <td className="p-2 text-xs">
                          <div>
                            أنشأ:{" "}
                            <span className="font-medium">
                              {r.createdByName ??
                                (r.createdBy != null ? `#${r.createdBy}` : "—")}
                            </span>
                          </div>
                          <div className="mt-1 text-muted-foreground">
                            اعتمد: {r.approvedByName ?? "—"}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            نفّذ: {r.executedByName ?? "لم يُنفذ بعد"}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {r.approvalStatus
                              ? (APPROVAL_LABEL[r.approvalStatus] ??
                                r.approvalStatus)
                              : "—"}
                            {r.receiptStatus
                              ? ` · إيصال ${r.receiptStatus}`
                              : ""}
                          </div>
                        </td>
                        <td
                          className="p-2 text-start text-base font-bold tabular-nums"
                          dir="ltr"
                        >
                          <FinancialCellProvenanceHover data={r.provenance}>
                            <span className="cursor-pointer hover:underline text-end block w-full">
                              {fmt(r.amount)}
                            </span>
                          </FinancialCellProvenanceHover>
                        </td>
                        <td className="p-2">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status] ?? "bg-muted"}`}
                            title={
                              r.status === "PENDING_APPROVAL"
                                ? "الوضع الراهن: بلا أثر مالي حتى التنفيذ الفعلي"
                                : undefined
                            }
                          >
                            {isApprovedAwaitingExecution(r)
                              ? "معتمد — بانتظار التنفيذ"
                              : (STATUS_LABEL[r.status] ?? r.status)}
                          </span>
                        </td>
                        <td className="max-w-52 p-2">
                          {warnings.length ? (
                            <div className="flex flex-wrap gap-1">
                              {warnings.map((warning) => (
                                <span
                                  key={warning}
                                  className="rounded-full badge-status-cancelled px-2 py-0.5 text-[11px]"
                                >
                                  {warning}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              لا ملاحظات
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`مسار تتبع المصروف ${Number(r.id)}`}
                              aria-expanded={traceExpanded}
                              disabled={!canTrace}
                              onClick={() => toggleTrace(Number(r.id))}
                            >
                              {traceExpanded ? (
                                <ChevronUp aria-hidden className="size-4" />
                              ) : (
                                <ChevronDown aria-hidden className="size-4" />
                              )}
                              تفاصيل
                            </Button>
                            <RowActions actions={actionsFor(r)} />
                          </div>
                        </td>
                      </tr>
                      {traceExpanded && (
                        <tr className="border-t bg-muted/20">
                          <td colSpan={11} className="p-3">
                            <ExpenseTracePanel expenseId={Number(r.id)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
            {loaded && visibleCount === 0 && (
              <TableEmptyRow
                colSpan={11}
                message={
                  auditOnly
                    ? "لا توجد حالات تدقيق مطابقة للفلاتر."
                    : query
                      ? "لا مصروفات مطابقة للبحث."
                      : "لا مصروفات لهذا الفلتر."
                }
              />
            )}
          </tbody>
        </table>
      </ScrollTableShell>
    </div>
  );
}
