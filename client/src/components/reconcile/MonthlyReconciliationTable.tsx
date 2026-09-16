import { DataTable } from "@/components/data-table/DataTable";
import { fmt } from "@/lib/money";
import { ROLE_LABELS } from "@/lib/doubleEntryRoleLabels";
import {
  PANEL_TABLE,
  type DoubleEntryData,
  type DoubleEntryRoleRow,
} from "./types";

export function MonthlyReconciliationTable({
  reconciliation,
}: {
  reconciliation: DoubleEntryData;
}) {
  const monthlyIssueCount =
    reconciliation.roles.filter((row) => row.drift !== "0.00").length +
    reconciliation.gapCount +
    reconciliation.missingCount +
    reconciliation.extraCount +
    reconciliation.scopeMismatchCount +
    reconciliation.unreconstructableCount +
    reconciliation.sourceMismatchCount +
    reconciliation.imbalancedJournalCount;

  return (
    <div className="border-t pt-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">مطابقة الشهر المختار</h3>
          <p className="text-xs text-muted-foreground">
            {reconciliation.scope.from} — {reconciliation.scope.to} ·{" "}
            {reconciliation.sourceEntryCount} حدثاً مصدرياً ·{" "}
            {reconciliation.journalEntryCount} رأس يومية
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${monthlyIssueCount === 0 ? "badge-status-active" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"}`}
        >
          {monthlyIssueCount === 0
            ? "مطابق"
            : `${monthlyIssueCount} مانعاً/انحرافاً`}
        </span>
      </div>

      {reconciliation.roles.length > 0 ? (
        <DataTable<DoubleEntryRoleRow>
          {...PANEL_TABLE}
          data={reconciliation.roles}
          emptyText="لا أحداث مالية في هذا النطاق."
          columns={[
            {
              id: "role",
              header: "الدور المحاسبي",
              accessorFn: (row) => ROLE_LABELS[row.role] ?? row.role,
              meta: { width: "wide" },
              cell: ({ row }) => (
                <span className="font-medium">
                  {ROLE_LABELS[row.original.role] ?? row.original.role}
                  <div className="text-[11px] font-normal text-muted-foreground" dir="ltr">
                    {row.original.role}
                  </div>
                </span>
              ),
            },
            { id: "expected", header: "المتوقّع", accessorFn: (row) => fmt(row.expected), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.expected) },
            { id: "actual", header: "الفعلي", accessorFn: (row) => fmt(row.actual), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.actual) },
            {
              id: "drift",
              header: "الانحراف",
              accessorFn: (row) => fmt(row.drift),
              meta: { kind: "money" },
              cell: ({ row }) => (
                <span className={row.original.drift === "0.00" ? undefined : "font-semibold text-[var(--sem-neg)]"}>
                  {fmt(row.original.drift)}
                </span>
              ),
            },
          ]}
        />
      ) : (
        <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
          لا أحداث مالية في هذا النطاق.
        </p>
      )}

      {(reconciliation.gapCount > 0 ||
        reconciliation.missingCount > 0 ||
        reconciliation.extraCount > 0 ||
        reconciliation.scopeMismatchCount > 0 ||
        reconciliation.unreconstructableCount > 0 ||
        reconciliation.sourceMismatchCount > 0) && (
        <div className="mt-2 text-xs text-muted-foreground">
          الفجوات: {reconciliation.gapCount} · المفقودة:{" "}
          {reconciliation.missingCount} · الزائدة:{" "}
          {reconciliation.extraCount} · اختلاف النطاق:{" "}
          {reconciliation.scopeMismatchCount} · غير القابلة لإعادة المطابقة:{" "}
          {reconciliation.unreconstructableCount} · اختلاف دليل المصدر:{" "}
          {reconciliation.sourceMismatchCount}
        </div>
      )}
    </div>
  );
}
