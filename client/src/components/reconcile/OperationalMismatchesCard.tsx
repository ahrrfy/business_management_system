import { DataTable } from "@/components/data-table/DataTable";
import { fmt } from "@/lib/money";
import { ROLE_LABELS } from "@/lib/doubleEntryRoleLabels";
import { PANEL_TABLE, type ActivationData, type OperationalMismatchRow } from "./types";

export function OperationalMismatchesCard({
  reconciliation,
}: {
  reconciliation: NonNullable<ActivationData["operationalReconciliation"]>;
}) {
  if (reconciliation.mismatches.length === 0 && reconciliation.blockers.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <div className="font-semibold">تفاصيل فروق المطابقة التشغيلية</div>
        <p className="text-xs text-muted-foreground">
          تعرض الصفوف المختلفة فقط لتحديد المصدر والدور والفرع الذي يحتاج
          إلى معالجة قبل اعتماد الدفتر.
        </p>
      </div>
      {reconciliation.mismatches.length > 0 && (
        <DataTable<OperationalMismatchRow>
          {...PANEL_TABLE}
          data={reconciliation.mismatches}
          emptyText="لا فروق مطابقة تشغيلية."
          columns={[
            {
              id: "scope",
              header: "النطاق",
              accessorFn: (row) => (row.scope === "GLOBAL" ? "الشركة" : `الفرع ${row.branchId}`),
              cell: ({ row }) => (row.original.scope === "GLOBAL" ? "الشركة" : `الفرع ${row.original.branchId}`),
            },
            {
              id: "role",
              header: "الدور المحاسبي",
              // التسمية المعروضة لا الرمز الخامّ — «نسخ القيمة» يجب أن يطابق ما يقرأه المستعمِل.
              accessorFn: (row) => ROLE_LABELS[row.role] ?? row.role,
              cell: ({ row }) => ROLE_LABELS[row.original.role] ?? row.original.role,
            },
            {
              id: "operationalNetDebit",
              header: "المصدر التشغيلي",
              accessorFn: (row) => fmt(row.operationalNetDebit),
              meta: { kind: "money" },
              cell: ({ row }) => fmt(row.original.operationalNetDebit),
            },
            {
              id: "journalNetDebit",
              header: "اليومية",
              accessorFn: (row) => fmt(row.journalNetDebit),
              meta: { kind: "money" },
              cell: ({ row }) => fmt(row.original.journalNetDebit),
            },
            {
              id: "difference",
              header: "الفرق",
              accessorFn: (row) => fmt(row.difference),
              meta: { kind: "money" },
              cell: ({ row }) => <span className="text-destructive">{fmt(row.original.difference)}</span>,
            },
          ]}
        />
      )}
      {reconciliation.blockers.map((item) => (
        <div
          key={`${item.code}:${item.source}`}
          className="rounded-md border border-destructive/30 p-2 text-sm"
        >
          <div className="font-medium">{item.code}</div>
          <div className="text-xs text-muted-foreground">
            {item.message} ({item.source})
          </div>
        </div>
      ))}
    </div>
  );
}
