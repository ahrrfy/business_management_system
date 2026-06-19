/**
 * تقرير WIP (Work-in-Progress) — قيمة المواد المُستهلَكة في أوامر شغل قيد التنفيذ.
 * managerBranchScopedProcedure.
 */
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

function fmtMoney(s: string | number | null | undefined): string {
  if (s == null) return "—";
  const n = typeof s === "string" ? Number(s) : s;
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("ar-IQ-u-nu-latn", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " د.ع";
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("ar-IQ-u-nu-latn", { year: "numeric", month: "2-digit", day: "2-digit" });
}

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
      <h1 className="text-2xl font-bold">تقرير WIP — قيمة الإنتاج تحت التنفيذ</h1>
      <p className="text-sm text-muted-foreground">
        المواد المُستهلَكة في أوامر شغل لم تُسلَّم بعد — قيمة معلَّقة بين «المخزون» و«تكلفة المبيع» (تظهر فعلياً في SALE.cost عند التسليم).
      </p>

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
            <p className="text-muted-foreground">جاري التحميل…</p>
          ) : (
            <>
              <div className="bg-blue-50 border border-blue-200 rounded p-3 grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">إجمالي الأوامر:</span> <span className="font-semibold">{wip.data?.totalCount ?? 0}</span></div>
                <div><span className="text-muted-foreground">قيمة WIP الإجمالية:</span> <span className="font-bold text-blue-900">{fmtMoney(wip.data?.totalMaterialsCost)}</span></div>
              </div>

              {(wip.data?.rows.length ?? 0) === 0 ? (
                <p className="text-muted-foreground text-sm pt-2">لا أوامر شغل قيد التنفيذ</p>
              ) : (
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
                      {wip.data!.rows.map((r) => (
                        <tr key={r.workOrderId} className="hover:bg-accent/40">
                          <td className="p-2 border font-mono">{r.orderNumber}</td>
                          <td className="p-2 border">{r.customerName ?? "—"}</td>
                          <td className="p-2 border">{STATUS_LABEL[r.status] ?? r.status}</td>
                          <td className="p-2 border font-semibold">{fmtMoney(r.materialsCost)}</td>
                          <td className="p-2 border text-muted-foreground">{fmtDate(r.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
