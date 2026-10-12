import { useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { DeliveryWorkspaceExport } from "./CompanyWorkspace";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/money";
import {
  buildDeliveryStatement,
  deliveryStatementReport,
} from "@/lib/deliveryWorkspace";
type PartyRow = RouterOutputs["delivery"]["listParties"][number];
type StatementRow = ReturnType<typeof buildDeliveryStatement>["rows"][number];
export function StatementTab({
  party,
  active,
}: {
  party: PartyRow;
  active: boolean;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const utils = trpc.useUtils();
  const exportedTotals = useRef<Record<string, string>>({});
  const filters = {
    partyId: party.id,
    from: from || undefined,
    to: to || undefined,
  };
  const q = trpc.delivery.partyStatement.useQuery(filters, { enabled: active });
  const built = useMemo(
    () =>
      q.data
        ? buildDeliveryStatement(q.data.entries, q.data.openingBalance)
        : null,
    [q.data],
  );
  const columns: ColumnDef<StatementRow, unknown>[] = [
    {
      id: "date",
      header: "التاريخ",
      accessorFn: (row) => fmtDate(row.entryDate),
      meta: { kind: "date" },
      enableSorting: false,
    },
    {
      id: "ref",
      header: "المرجع",
      accessorFn: (row) => row.ref,
      meta: { kind: "code" },
      enableSorting: false,
    },
    {
      id: "description",
      header: "البيان",
      accessorFn: (row) => row.description,
      meta: { wrap: true, width: "wide" },
      enableSorting: false,
    },
    {
      id: "debit",
      header: "مدين (عهدة+)",
      accessorFn: (row) => (row.debit ? fmt(row.debit) : "—"),
      meta: { kind: "money" },
      enableSorting: false,
    },
    {
      id: "credit",
      header: "دائن / إفصاح",
      accessorFn: (row) => (row.credit ? fmt(row.credit) : "—"),
      meta: { kind: "money" },
      enableSorting: false,
    },
    {
      id: "balance",
      header: "الرصيد الجاري",
      accessorFn: (row) => (row.balance ? fmt(row.balance) : ""),
      meta: { kind: "money" },
      enableSorting: false,
    },
  ];
  const statementExport = async () => {
    const result = await utils.delivery.partyStatement.fetch(filters, {
      staleTime: 0,
    });
    if (!result) throw new Error("تعذر جلب كشف الحساب. أعد المحاولة.");
    const statement = deliveryStatementReport(result);
    exportedTotals.current = statement.totals;
    return statement.rows.map((row) => ({
      date: fmtDate(row.entryDate),
      ref: row.ref,
      description: row.description,
      debit: row.debit ?? "",
      credit: row.credit ?? "",
      balance: row.carry,
      opening: result.openingBalance,
      closing: result.closingBalance,
      debitTotal: result.debitTotal,
      creditTotal: result.creditTotal,
    }));
  };
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
        title="كشف حساب الشركة"
        company={party.name}
        branch={
          q.data?.scopedBranchId == null
            ? "جميع الفروع المخولة"
            : `الفرع #${q.data.scopedBranchId}`
        }
        filters={`من: ${from || "البداية"} · إلى: ${to || "اليوم"}`}
        columns={[
          { key: "date", header: "التاريخ" },
          { key: "ref", header: "المرجع", text: true },
          { key: "description", header: "البيان" },
          { key: "debit", header: "مدين", money: true },
          { key: "credit", header: "دائن / إفصاح", money: true },
          { key: "balance", header: "الرصيد الجاري", money: true },
          { key: "opening", header: "رصيد افتتاح الفترة", money: true },
          { key: "closing", header: "رصيد ختام الفترة", money: true },
          { key: "debitTotal", header: "إجمالي المدين", money: true },
          { key: "creditTotal", header: "إجمالي الدائن", money: true },
        ]}
        load={statementExport}
        totals={() => exportedTotals.current}
      />
      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          افتتاح الفترة: <b dir="ltr">{fmt(q.data?.openingBalance)} د.ع</b>
        </div>
        <div>
          مدين الفترة: <b dir="ltr">{fmt(q.data?.debitTotal)} د.ع</b>
        </div>
        <div>
          دائن الفترة: <b dir="ltr">{fmt(q.data?.creditTotal)} د.ع</b>
        </div>
        <div>
          ختام الفترة: <b dir="ltr">{fmt(q.data?.closingBalance)} د.ع</b>
        </div>
      </div>
      <DataTable<StatementRow>
        columns={columns}
        data={built?.rows ?? []}
        searchable={false}
        pageSize={50}
        loading={q.isLoading}
        errorState={{
          isError: q.isError,
          message: q.error?.message,
          onRetry: () => void q.refetch(),
        }}
        emptyText="لا حركات في هذه الفترة"
        getRowClassName={(row) =>
          row.info ? "bg-muted/20 text-muted-foreground" : undefined
        }
      />
      <p className="text-xs text-muted-foreground">
        رصيد الافتتاح يشمل ما قبل الفترة. الأجور والأمانات صفوف إفصاح لا تغير
        رصيد العهدة. جميع حركات الفترة متاحة بالتصفح والتصدير.
      </p>
    </div>
  );
}
