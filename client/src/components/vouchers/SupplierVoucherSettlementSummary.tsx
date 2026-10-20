import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/DataTable";
import { fmt } from "@/lib/money";
import { voucherApprovalLabel } from "./voucherUiPolicy";

type SavedAllocation = {
  supplierInvoiceId: number;
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
};
type SavedSettlement = {
  status: string;
  allocations: readonly SavedAllocation[];
};
const columns: ColumnDef<SavedAllocation, unknown>[] = [
  {
    id: "invoice",
    header: "فاتورة المورّد",
    accessorFn: (row) => row.invoiceNumber,
    enableSorting: false,
    cell: ({ row }) => row.original.invoiceNumber,
  },
  {
    id: "date",
    header: "تاريخ الفاتورة",
    meta: { kind: "date" },
    enableSorting: false,
    cell: ({ row }) => row.original.invoiceDate.slice(0, 10),
  },
  {
    id: "amount",
    header: "مبلغ التسوية د.ع",
    meta: { kind: "money" },
    enableSorting: false,
    cell: ({ row }) => fmt(row.original.amount),
  },
];

/** Displays only the settlement persisted by the server; it never proposes or edits allocations. */
export function SupplierVoucherSettlementSummary({
  settlement,
}: {
  settlement: SavedSettlement | null | undefined;
}) {
  if (!settlement) return null;
  const status = voucherApprovalLabel({
    direction: "OUT",
    approvalStatus:
      settlement.status === "PENDING" ? "PENDING_APPROVAL" : settlement.status,
  });
  return (
    <section
      dir="rtl"
      aria-label="تسوية فواتير المورد المحفوظة"
      className="space-y-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-semibold">تسوية فواتير المورّد</span>
        <span>{status}</span>
      </div>
      <DataTable<SavedAllocation>
        embedded
        searchable={false}
        bounded={false}
        pageSize={Infinity}
        columns={columns}
        data={[...settlement.allocations]}
        mobileCardRenderer={(allocation) => (
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold">{allocation.invoiceNumber}</span>
              <span dir="ltr" className="tabular-nums">
                {fmt(allocation.amount)} د.ع
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              تاريخ الفاتورة:{" "}
              <span dir="ltr" className="inline-block">
                {allocation.invoiceDate.slice(0, 10)}
              </span>
            </p>
          </div>
        )}
        emptyText="لا توجد فواتير مرتبطة بهذا السند."
      />
    </section>
  );
}
