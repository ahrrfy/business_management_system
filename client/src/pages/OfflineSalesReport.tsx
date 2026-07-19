// تقرير «المبيعات الأوفلاين» — الشريحة ٥ من خطة الأوفلاين.
// عين الإدارة على التجربة المُقاسة: كل فاتورة التُقطت دون اتصال بربط رقمها المؤقّت بالرسمي،
// وزمن ترحيلها، ووسم «مُزامنة لاحقاً» — مع مؤشرات إجمالية تطابق معايير نجاح التجربة.

import { PageHeader } from "@/components/PageHeader";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CloudUpload, Timer } from "lucide-react";
import { useState } from "react";

function fmtIQD(v: string | number): string {
  return Number(v).toLocaleString("en");
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "short", timeStyle: "short" });
}

export default function OfflineSalesReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const report = trpc.offline.salesReport.useQuery({
    from: from || undefined,
    to: to || undefined,
  });
  const totals = report.data?.totals;

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="المبيعات الأوفلاين"
        description="الفواتير الملتقطة دون اتصال وترحيلها — عين الإدارة على تجربة العمل ثنائي الاتجاه"
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold">
          من تاريخ
          <input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)}
            className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" />
        </label>
        <label className="text-xs font-semibold">
          إلى تاريخ
          <input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)}
            className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm" />
        </label>
      </div>

      {/* مؤشرات التجربة */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">فواتير أوفلاينية</p>
          <p className="text-xl font-bold">{totals?.count ?? "—"}</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">إجمالي القيمة</p>
          <p className="text-xl font-bold">{totals ? `${fmtIQD(totals.total)} د.ع` : "—"}</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Timer aria-hidden className="size-3" /> زمن الترحيل (متوسط / أقصى)
          </p>
          <p className="text-xl font-bold">
            {totals?.avgLagMinutes != null ? `${totals.avgLagMinutes} د / ${totals.maxLagMinutes} د` : "—"}
          </p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <AlertTriangle aria-hidden className="size-3" /> مُزامنة بعد إغلاق الوردية
          </p>
          <p className="text-xl font-bold">{totals?.lateSyncedCount ?? "—"}</p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-xs">
            <tr>
              <th className="p-2 text-start">الفاتورة الرسمية</th>
              <th className="p-2 text-start">الإيصال المؤقّت</th>
              <th className="p-2 text-start">الفرع</th>
              <th className="p-2 text-start">الالتقاط</th>
              <th className="p-2 text-start">الترحيل</th>
              <th className="p-2 text-start">التأخّر</th>
              <th className="p-2 text-start">الإجمالي</th>
              <th className="p-2 text-start">ملاحظات</th>
            </tr>
          </thead>
          <tbody>
            {report.isLoading ? (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">جارٍ التحميل…</td></tr>
            ) : !report.data?.rows.length ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  <CloudUpload aria-hidden className="mx-auto mb-2 size-6" />
                  لا مبيعات أوفلاينية في النطاق المحدد
                </td>
              </tr>
            ) : (
              report.data.rows.map((r) => (
                <tr key={r.invoiceId} className="border-t">
                  <td className="p-2 font-mono">{r.invoiceNumber}</td>
                  <td className="p-2 font-mono text-muted-foreground">{r.offlineReceiptNumber ?? "—"}</td>
                  <td className="p-2">{r.branchId}</td>
                  <td className="p-2 text-xs">{fmtDateTime(r.capturedAt)}</td>
                  <td className="p-2 text-xs">{fmtDateTime(r.syncedAt)}</td>
                  <td className="p-2">{r.replayLagMinutes != null ? `${r.replayLagMinutes} د` : "—"}</td>
                  <td className="p-2 font-semibold">{fmtIQD(r.total)} د.ع</td>
                  <td className="p-2">
                    {r.lateSynced ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                        مُزامنة بعد الإغلاق
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
