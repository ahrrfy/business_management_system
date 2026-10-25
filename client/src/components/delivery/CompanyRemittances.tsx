import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { DeliveryWorkspaceExport } from "./CompanyWorkspace";
import { moneyCol } from "./companyConsignmentColumns";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtDateTime } from "@/lib/date";
import { deliveryTotals, fetchAllDeliveryPages } from "@/lib/deliveryWorkspace";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";
import { printRemittanceReceipt } from "./printRemittanceReceipt";
type PartyRow = RouterOutputs["delivery"]["listParties"][number];
type RemittanceRow =
  RouterOutputs["delivery"]["remittancesPage"]["rows"][number];
export function RemittancesTab({
  party,
  active,
}: {
  party: PartyRow;
  active: boolean;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursors, setCursors] = useState<Array<number | undefined>>([
    undefined,
  ]);
  const [page, setPage] = useState(0);
  const utils = trpc.useUtils();
  useEffect(() => {
    setPage(0);
    setCursors([undefined]);
  }, [from, to]);
  const filters = {
    partyId: party.id,
    from: from || undefined,
    to: to || undefined,
    limit: 50,
  };
  const q = trpc.delivery.remittancesPage.useQuery(
    { ...filters, cursor: cursors[page] },
    { enabled: active },
  );
  const columns: ColumnDef<RemittanceRow, unknown>[] = [
    {
      id: "number",
      header: "رقم التوريد",
      accessorFn: (row) => row.remittanceNumber,
      meta: { kind: "code" },
    },
    {
      id: "date",
      header: "التاريخ",
      accessorFn: (row) => fmtDateTime(row.receivedAt),
      meta: { kind: "datetime" },
    },
    moneyCol<RemittanceRow>(
      "settled",
      "إجمالي التسوية",
      (row) => row.collectedTotal,
    ),
    moneyCol<RemittanceRow>(
      "cash",
      "النقد المستلم فعلا",
      (row) => row.cashReceived,
    ),
    moneyCol<RemittanceRow>("fee", "الأجور", (row) => row.feesTotal),
    moneyCol<RemittanceRow>(
      "net",
      "صافي التوريد المسجل",
      (row) => row.netRemitted,
    ),
    moneyCol<RemittanceRow>(
      "shortfall",
      "عجز بقي عهدة",
      (row) => row.shortfallTotal,
    ),
    {
      id: "receivedBy",
      header: "استلمه",
      accessorFn: (row) => row.receivedByName ?? "—",
      meta: { kind: "actor" },
    },
    {
      id: "status",
      header: "المطابقة",
      accessorFn: (row) =>
        row.status === "BALANCED"
          ? "مطابق"
          : row.status === "SHORT"
            ? "بعجز"
            : "بزيادة",
      meta: { kind: "status" },
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
          onClick={() =>
            printRemittanceReceipt(party.name, {
              remittanceNumber: row.original.remittanceNumber,
              collectedTotal: row.original.collectedTotal,
              feesTotal: row.original.feesTotal,
              netRemitted: row.original.netRemitted,
              shortfallTotal: row.original.shortfallTotal,
              cashReceived: row.original.cashReceived,
              receivedAt: row.original.receivedAt,
              branchId: row.original.branchId,
              shiftId: row.original.shiftId,
              receivedByName: row.original.receivedByName,
              copy: {
                kind: "REPRINT",
                reason: "طلب إعادة طباعة من سجل توريدات الشركة",
              },
            })
          }
        >
          <Printer aria-hidden className="size-3.5" />
          إعادة طباعة
        </Button>
      ),
    },
  ];
  const exportColumns = [
    { key: "number", header: "رقم التوريد", text: true },
    { key: "date", header: "التاريخ (توقيت الجهاز)" },
    { key: "settled", header: "إجمالي التسوية", money: true },
    { key: "cash", header: "النقد المستلم فعلا", money: true },
    { key: "fee", header: "الأجور", money: true },
    { key: "net", header: "صافي التوريد المسجل", money: true },
    { key: "shortfall", header: "عجز بقي عهدة", money: true },
    { key: "receivedBy", header: "استلمه" },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          من{" "}
          <Input
            className="w-40"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          إلى{" "}
          <Input
            className="w-40"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      <DeliveryWorkspaceExport
        ready={q.isSuccess && !q.isFetching}
        title="سجل توريدات الشركة"
        company={party.name}
        branch={
          q.data?.scopedBranchId == null
            ? "جميع الفروع المخولة"
            : `الفرع #${q.data.scopedBranchId}`
        }
        filters={`تاريخ التوريد (UTC) من: ${from || "البداية"} · إلى: ${to || "اليوم"}`}
        columns={exportColumns}
        load={async () =>
          (
            await fetchAllDeliveryPages((cursor) =>
              utils.delivery.remittancesPage.fetch(
                {
                  ...filters,
                  limit: 500,
                  cursor,
                },
                { staleTime: 0 },
              ),
            )
          ).map((row) => ({
            number: row.remittanceNumber,
            date: fmtDateTime(row.receivedAt),
            settled: row.collectedTotal,
            cash: row.cashReceived,
            fee: row.feesTotal,
            net: row.netRemitted,
            shortfall: row.shortfallTotal,
            receivedBy: row.receivedByName ?? "",
          }))
        }
        totals={(rows) => {
          const total = deliveryTotals(rows, [
            "settled",
            "cash",
            "fee",
            "net",
            "shortfall",
          ]);
          return {
            "إجمالي التسوية": total.settled,
            "النقد المستلم فعلا": total.cash,
            الأجور: total.fee,
            "صافي التوريد المسجل": total.net,
            العجز: total.shortfall,
          };
        }}
      />
      <p className="text-xs text-muted-foreground">
        النقد المستلم فعلا مستقل عن إجمالي التسوية وخصم الأجور. التصدير يشمل
        كامل الفترة. فلترة تاريخ التوريد حسب يوم العمل (UTC)، والعرض والتصدير بتوقيت جهازك.
      </p>
      <DataTable<RemittanceRow>
        data={q.data?.rows ?? []}
        columns={columns}
        searchable={false}
        externalFiltersActive={Boolean(from || to)}
        loading={q.isLoading}
        errorState={{
          isError: q.isError,
          message: q.error?.message,
          onRetry: () => void q.refetch(),
        }}
        emptyText="لا توريدات في هذه الفترة"
        serverPagination={{
          page,
          pageSize: 50,
          hasMore: q.data?.hasMore,
          isFetching: q.isFetching,
          onPageChange: (next) => {
            if (next < page) setPage(next);
            else if (q.data?.nextCursor != null) {
              setCursors((current) => [
                ...current.slice(0, next),
                q.data!.nextCursor!,
              ]);
              setPage(next);
            }
          },
        }}
      />
    </div>
  );
}
