/**
 * تقرير WIP (Work-in-Progress) — قيمة المواد المُستهلَكة في طلبات خدمة قيد التنفيذ.
 * managerBranchScopedProcedure.
 */
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { fmtDate } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";

const STATUS_LABEL: Record<string, string> = {
  IN_PROGRESS: "قيد التنفيذ",
  READY: "جاهز للتسليم",
};

export default function WIPReportPage() {
  const branches = trpc.branches.list.useQuery();
  const [branchId, setBranchId] = useState<number | null>(null);
  const wip = trpc.reports.wipReport.useQuery({ branchId: branchId ?? undefined });

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-6xl">
      <PageHeader
        title="تقرير WIP — قيمة الإنتاج تحت التنفيذ"
        description="المواد المُستهلَكة في طلبات خدمة لم تُسلَّم بعد — قيمة معلَّقة بين «المخزون» و«تكلفة المبيع» (تظهر فعلياً في SALE.cost عند التسليم)."
      />

      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <label className="text-sm font-medium">الفرع</label>
              <select
                value={branchId ?? ""}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : null)}
                className="h-9 px-3 rounded-md border bg-transparent text-sm"
              >
                <option value="">كل الفروع</option>
                {branches.data?.map((b: any) => (
                  <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                ))}
              </select>
            </div>
          </div>

          {wip.isLoading ? (
            <LoadingState />
          ) : wip.isError ? (
            <ErrorState message={wip.error.message} onRetry={() => wip.refetch()} />
          ) : (
            <>
              <div className="badge-status-pending rounded p-3 grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">إجمالي الأوامر:</span> <span className="font-semibold">{wip.data?.totalCount ?? 0}</span></div>
                <div><span className="text-muted-foreground">قيمة WIP الإجمالية:</span> <span className="font-bold">{formatIqd(wip.data?.totalMaterialsCost)}</span></div>
              </div>

              <div className="overflow-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-right p-2 border">رقم الأمر</th>
                      <th className="text-right p-2 border">العميل</th>
                      <th className="text-right p-2 border">الحالة</th>
                      <th className="text-right p-2 border">قيمة المواد</th>
                      <th className="text-right p-2 border">تاريخ الإنشاء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(wip.data?.rows.length ?? 0) === 0 ? (
                      <TableEmptyRow colSpan={5} message="لا طلبات خدمة قيد التنفيذ" />
                    ) : (
                      wip.data!.rows.map((r) => (
                        <tr key={r.workOrderId} className="hover:bg-accent/40">
                          <td className="p-2 border font-mono">{r.orderNumber}</td>
                          <td className="p-2 border">{r.customerName ?? "—"}</td>
                          <td className="p-2 border">{STATUS_LABEL[r.status] ?? r.status}</td>
                          <td className="p-2 border font-semibold">{formatIqd(r.materialsCost)}</td>
                          <td className="p-2 border text-muted-foreground">{fmtDate(r.createdAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
