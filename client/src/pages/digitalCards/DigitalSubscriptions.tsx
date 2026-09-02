import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField, ListToolbar } from "@/components/list";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Link } from "wouter";
import { useMemo } from "react";

/** صفٌّ من عقد `digitalCards.subscriptions.list` — لا يُعاد تعريفه محلياً. */
type SubscriptionRow = RouterOutputs["digitalCards"]["subscriptions"]["list"][number];

const STATUS: Record<string, string> = {
  ISSUED: "مباع",
  LOSS_REFUND_PENDING: "طلب إلغاء ينتظر الاعتماد",
  REVERSED: "أُلغي وأُعيد المبلغ",
  LOSS_REFUND: "أُعيد المبلغ وسُجّلت خسارة",
};

export default function DigitalSubscriptions() {
  const utils = trpc.useUtils();
  const branches = trpc.branches.list.useQuery();
  const me = trpc.auth.me.useQuery();
  const canPickBranch = me.data?.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
  const [f, setF, resetF] = useUrlFilters({ branch: "", q: "" });

  const list = trpc.digitalCards.subscriptions.list.useQuery({
    branchId: f.branch ? Number(f.branch) : undefined,
    q: f.q.trim() || undefined,
  });

  const columns = useMemo<ColumnDef<SubscriptionRow, unknown>[]>(() => [
    { id: "invoiceDate", header: "وقت البيع", meta: { kind: "datetime" }, cell: ({ row }) => fmtDateTime(row.original.invoiceDate) },
    {
      id: "invoice",
      header: "الفاتورة",
      cell: ({ row }) => (
        <Link href={`/invoices/${row.original.invoiceId}`} className="font-semibold text-primary hover:underline">
          {row.original.invoiceNumber}
        </Link>
      ),
    },
    { id: "offering", header: "الاشتراك", meta: { width: "wide" }, cell: ({ row }) => <span className="font-medium">{row.original.offeringName}</span> },
    {
      id: "providerReference",
      header: "رقم الاشتراك أو ID",
      meta: { kind: "code" },
      cell: ({ row }) => <span className="font-bold">{row.original.providerReference || "—"}</span>,
    },
    { id: "student", header: "الطالب", cell: ({ row }) => <span className="font-medium">{row.original.studentName || "—"}</span> },
    { id: "phone", header: "الهاتف", meta: { kind: "phone" }, cell: ({ row }) => <span className="font-mono">{row.original.studentPhone || "—"}</span> },
    { id: "price", header: "السعر", meta: { kind: "money" }, cell: ({ row }) => <span className="font-semibold">{fmtAr(row.original.sellPrice)}</span> },
    // عمود الفرع لمن يعبر الفروع فقط — مرآةُ عزل مدير الفرع أعلاه.
    ...(canPickBranch
      ? [{ id: "branch", header: "الفرع", cell: ({ row }) => <span className="text-muted-foreground">{row.original.branchName}</span> } as ColumnDef<SubscriptionRow, unknown>]
      : []),
    {
      id: "status",
      header: "الحالة",
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span className="inline-block rounded-full px-2 py-0.5 text-xs badge-status-neutral">
          {STATUS[row.original.fulfillmentStatus] ?? row.original.fulfillmentStatus}
        </span>
      ),
    },
  ], [canPickBranch]);


  return (
    <div className="space-y-4">
      <PageHeader
        title="مبيعات الاشتراكات"
        description="سجل بيع واضح للمطابقة: رقم الاشتراك، الطالب، الهاتف والفاتورة. الصلاحية والمتبقي تديرهما المنصة التعليمية."
      />

      <Card>
        <CardContent className="p-4">
          <ListToolbar
            title="سجل البيع"
            count={list.data?.length}
            loading={list.isLoading}
            search={{
              value: f.q,
              onChange: (v) => setF({ q: v }),
              placeholder: "اسم الطالب أو الهاتف أو رقم الاشتراك…",
              ariaLabel: "بحث في مبيعات الاشتراكات",
            }}
            activeFilterCount={f.branch ? 1 : 0}
            onResetFilters={resetF}
            onRefresh={() => void utils.digitalCards.subscriptions.list.invalidate()}
            refreshing={list.isFetching}
            filters={canPickBranch ? (
              <FilterField label="الفرع" className="w-40">
                <AppSelect size="sm" value={f.branch} onValueChange={(v) => setF({ branch: v })}>
                  <option value="">— كل الفروع —</option>
                  {(branches.data ?? []).map((branch) => <option key={branch.id} value={String(branch.id)}>{branch.name}</option>)}
                </AppSelect>
              </FilterField>
            ) : undefined}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            data={list.data ?? []}
            /* البحث في ListToolbar أعلاه (يذهب للخادم) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: list.error?.message, onRetry: () => list.refetch() }}
            emptyText="لا توجد مبيعات اشتراكات مطابقة."
          />
        </CardContent>
      </Card>
    </div>
  );
}
