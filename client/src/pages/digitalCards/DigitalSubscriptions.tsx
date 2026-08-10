import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { Card, CardContent } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField, ListToolbar } from "@/components/list";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { fmtDateTime } from "@/lib/date";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";

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
  const canPickBranch = me.data?.role === "admin" || me.data?.role === "manager";
  const [f, setF, resetF] = useUrlFilters({ branch: "", q: "" });

  const list = trpc.digitalCards.subscriptions.list.useQuery({
    branchId: f.branch ? Number(f.branch) : undefined,
    q: f.q.trim() || undefined,
  });

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
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">وقت البيع</th>
                  <th className="p-2 text-start">الفاتورة</th>
                  <th className="p-2 text-start">الاشتراك</th>
                  <th className="p-2 text-start">رقم الاشتراك أو ID</th>
                  <th className="p-2 text-start">الطالب</th>
                  <th className="p-2 text-start">الهاتف</th>
                  <th className="p-2 text-start">السعر</th>
                  {canPickBranch && <th className="p-2 text-start">الفرع</th>}
                  <th className="p-2 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((sale) => (
                  <tr key={sale.id} className="border-t">
                    <td className="p-2 tabular-nums whitespace-nowrap" dir="ltr">{fmtDateTime(sale.invoiceDate)}</td>
                    <td className="p-2"><Link href={`/invoices/${sale.invoiceId}`} className="font-semibold text-primary hover:underline">{sale.invoiceNumber}</Link></td>
                    <td className="p-2 font-medium">{sale.offeringName}</td>
                    <td className="p-2 font-mono font-bold" dir="ltr">{sale.providerReference || "—"}</td>
                    <td className="p-2 font-medium">{sale.studentName || "—"}</td>
                    <td className="p-2 font-mono" dir="ltr">{sale.studentPhone || "—"}</td>
                    <td className="p-2 tabular-nums font-semibold">{fmtAr(sale.sellPrice)}</td>
                    {canPickBranch && <td className="p-2 text-muted-foreground">{sale.branchName}</td>}
                    <td className="p-2 text-center"><span className="inline-block rounded-full px-2 py-0.5 text-xs badge-status-neutral">{STATUS[sale.fulfillmentStatus] ?? sale.fulfillmentStatus}</span></td>
                  </tr>
                ))}
                {list.isLoading && <tr><td colSpan={canPickBranch ? 9 : 8}><LoadingState /></td></tr>}
                {!list.isLoading && (list.data?.length ?? 0) === 0 && (
                  <TableEmptyRow colSpan={canPickBranch ? 9 : 8} message="لا توجد مبيعات اشتراكات مطابقة." />
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
