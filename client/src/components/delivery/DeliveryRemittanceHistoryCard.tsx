import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { FileCheck2, Printer } from "lucide-react";
import { DataTable } from "@/components/data-table/DataTable";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/money";
import { fmtDateTime } from "@/lib/date";
import type { RouterOutputs } from "@/lib/trpc";
import { printRemittanceReceipt } from "@/components/delivery/printRemittanceReceipt";

export type RemittanceRow = RouterOutputs["delivery"]["remittances"][number];

export function DeliveryRemittanceHistoryCard({
  partyName,
  remittances,
}: {
  partyName: string;
  remittances: {
    data?: RemittanceRow[];
    isLoading?: boolean;
    isError?: boolean;
    error?: { message?: string } | null;
    refetch: () => void;
  };
}) {
  const remittanceColumns = useMemo<ColumnDef<RemittanceRow, unknown>[]>(
    () => [
      { id: "remittanceNumber", header: "رقم السند", accessorFn: (r) => r.remittanceNumber ?? "—", meta: { kind: "code" }, cell: ({ row }) => row.original.remittanceNumber ?? "—" },
      {
        id: "receivedAt",
        header: "التاريخ",
        accessorFn: (r) => fmtDateTime(r.receivedAt as unknown as string),
        meta: { kind: "datetime", align: "start" },
        cell: ({ row }) => <span className="text-[11px] text-muted-foreground">{fmtDateTime(row.original.receivedAt as unknown as string)}</span>,
      },
      { id: "collectedTotal", header: "إجمالي التحصيل", accessorFn: (r) => fmt(r.collectedTotal), meta: { kind: "money" }, cell: ({ row }) => fmt(row.original.collectedTotal) },
      {
        id: "netRemitted",
        header: "صافي التوريد",
        accessorFn: (r) => fmt(r.netRemitted),
        meta: { kind: "money" },
        cell: ({ row }) => <span className="font-bold text-money-positive">{fmt(row.original.netRemitted)}</span>,
      },
      {
        id: "shortfallTotal",
        header: "العجز",
        accessorFn: (r) => (Number(r.shortfallTotal) > 0 ? fmt(r.shortfallTotal) : "—"),
        meta: { kind: "money" },
        cell: ({ row }) => (
          <span className="text-destructive">{Number(row.original.shortfallTotal) > 0 ? fmt(row.original.shortfallTotal) : "—"}</span>
        ),
      },
      {
        id: "receivedByName",
        header: "المستلم",
        accessorFn: (r) => r.receivedByName ?? "—",
        meta: { kind: "actor" },
        cell: ({ row }) => <span className="text-[11px]">{row.original.receivedByName ?? "—"}</span>,
      },
      {
        id: "print",
        header: "المستند",
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs"
            disabled={!row.original.remittanceNumber}
            title={
              row.original.remittanceNumber
                ? "إعادة طباعة لقطة سند التوريد"
                : "لا يوجد رقم سند قابل للطباعة"
            }
            onClick={() =>
              printRemittanceReceipt(partyName, {
                remittanceNumber: row.original.remittanceNumber,
                collectedTotal: row.original.collectedTotal,
                feesTotal: row.original.feesTotal,
                netRemitted: row.original.netRemitted,
                shortfallTotal: row.original.shortfallTotal,
                cashReceived: row.original.cashReceived,
                receivedAt: row.original.receivedAt as unknown as string,
                branchId: row.original.branchId,
                shiftId: row.original.shiftId,
                receivedByName: row.original.receivedByName,
                copy: { kind: "REPRINT", reason: "طلب إعادة طباعة من سجل التوريدات" },
              })
            }
          >
            <Printer aria-hidden className="size-3.5" />
            إعادة طباعة
          </Button>
        ),
      },
    ],
    [partyName],
  );

  const rows = remittances.data ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="inline-flex items-center gap-2 text-sm font-bold">
          <FileCheck2 aria-hidden className="size-4 text-primary" />
          سجل توريدات {partyName} (آخر {rows.length})
        </span>
      </div>
      <DataTable<RemittanceRow>
        columns={remittanceColumns}
        data={rows}
        embedded
        searchable={false}
        pageSize={Infinity}
        loading={!!remittances.isLoading}
        errorState={{ isError: Boolean(remittances.isError), message: remittances.error?.message, onRetry: () => void remittances.refetch() }}
        emptyText="لا توريدات سابقة لهذه الجهة."
      />
    </div>
  );
}
