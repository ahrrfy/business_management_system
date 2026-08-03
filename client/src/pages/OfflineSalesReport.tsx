// تقرير «المبيعات الأوفلاين» — الشريحة ٥ من خطة الأوفلاين.
// عين الإدارة على التجربة المُقاسة: كل فاتورة التُقطت دون اتصال بربط رقمها المؤقّت بالرسمي،
// وزمن ترحيلها، ووسم «مُزامنة لاحقاً» — مع مؤشرات إجمالية تطابق معايير نجاح التجربة.
// خادمياً: offline.salesReport يدعم branchId اختيارياً أصلاً — لا تغيير هنا سوى كشفه بالواجهة.

import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { AppSelect } from "@/components/ui/AppSelect";
import { FilterField } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { fmtDateTime as formatDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { AlertTriangle, CloudUpload } from "lucide-react";
import { useState } from "react";

type Row = RouterOutputs["offline"]["salesReport"]["rows"][number];

function fmtIQD(v: string | number): string {
  return Number(v).toLocaleString("en");
}

function fmtDateTime(iso: string | null): string {
  return formatDateTime(iso);
}

export default function OfflineSalesReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const report = trpc.offline.salesReport.useQuery({
    from: from || undefined,
    to: to || undefined,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const rows = report.data?.rows ?? [];
  const totals = report.data?.totals;

  const branchName = (id: number) =>
    branches.data?.find((b) => Number(b.id) === id)?.name ?? `فرع #${id}`;
  const branchLabel = branchId ? branchName(Number(branchId)) : "الكل";
  const periodLabel = from || to ? `${from || "—"} — ${to || "—"}` : "كل الفترة";

  const kpis: KpiItem[] = totals
    ? [
        { label: "فواتير أوفلاينية", value: totals.count },
        { label: "إجمالي القيمة", value: `${fmtIQD(totals.total)} د.ع`, tone: "info" },
        {
          label: "زمن الترحيل (متوسط / أقصى)",
          value: totals.avgLagMinutes != null ? `${totals.avgLagMinutes} / ${totals.maxLagMinutes} د` : "—",
        },
        { label: "مُزامنة بعد إغلاق الوردية", value: totals.lateSyncedCount, tone: totals.lateSyncedCount ? "warning" : "default" },
      ]
    : [];

  function onExport() {
    exportRows(rows, {
      filename: "المبيعات-الأوفلاين",
      title: "المبيعات الأوفلاين",
      meta: [{ label: "الفرع", value: branchLabel }, { label: "الفترة", value: periodLabel }],
      columns: [
        { key: "invoiceNumber", header: "الفاتورة الرسمية" },
        { key: "offlineReceiptNumber", header: "الإيصال المؤقّت", map: (r) => r.offlineReceiptNumber ?? "—" },
        { key: "branchId", header: "الفرع", map: (r) => branchName(r.branchId) },
        { key: "capturedAt", header: "الالتقاط", map: (r) => fmtDateTime(r.capturedAt) },
        { key: "syncedAt", header: "الترحيل", map: (r) => fmtDateTime(r.syncedAt) },
        { key: "replayLagMinutes", header: "التأخّر (د)", map: (r) => r.replayLagMinutes ?? "" },
        { key: "total", header: "الإجمالي", money: true, map: (r) => Number(r.total) },
        { key: "lateSynced", header: "ملاحظات", map: (r) => (r.lateSynced ? "مُزامنة بعد الإغلاق" : "") },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: "المبيعات الأوفلاين",
      headerExtra: [
        { label: "الفرع", value: branchLabel },
        { label: "الفترة", value: periodLabel },
      ],
      columns: [
        { key: "invoiceNumber", label: "الفاتورة الرسمية" },
        { key: "offlineReceiptNumber", label: "الإيصال المؤقّت" },
        { key: "branchName", label: "الفرع" },
        { key: "capturedAt", label: "الالتقاط" },
        { key: "syncedAt", label: "الترحيل" },
        { key: "replayLagMinutes", label: "التأخّر", align: "left" },
        { key: "total", label: "الإجمالي", align: "left" },
        { key: "notes", label: "ملاحظات" },
      ],
      rows: rows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        offlineReceiptNumber: r.offlineReceiptNumber ?? "—",
        branchName: branchName(r.branchId),
        capturedAt: fmtDateTime(r.capturedAt),
        syncedAt: fmtDateTime(r.syncedAt),
        replayLagMinutes: r.replayLagMinutes != null ? `${r.replayLagMinutes} د` : "—",
        total: `${fmtIQD(r.total)} د.ع`,
        notes: r.lateSynced ? "مُزامنة بعد الإغلاق" : "",
      })),
      summary: totals
        ? [
            { label: "فواتير أوفلاينية", value: String(totals.count) },
            { label: "مُزامنة بعد الإغلاق", value: String(totals.lateSyncedCount) },
            { label: "إجمالي القيمة", value: `${fmtIQD(totals.total)} د.ع`, large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="المبيعات الأوفلاين"
      description="الفواتير الملتقطة دون اتصال وترحيلها — عين الإدارة على تجربة العمل ثنائي الاتجاه"
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="من تاريخ">
            <input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm" />
          </FilterField>
          <FilterField label="إلى تاريخ">
            <input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm" />
          </FilterField>
          <FilterField label="الفرع" className="w-40">
            <AppSelect value={branchId ? String(branchId) : ""} onValueChange={(v) => setBranchId(v ? Number(v) : "")}>
              <option value="">كل الفروع</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </AppSelect>
          </FilterField>
        </div>
      }
    >
      <ScrollTableShell bordered>
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
            ) : !rows.length ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  <CloudUpload aria-hidden className="mx-auto mb-2 size-6" />
                  لا مبيعات أوفلاينية في النطاق المحدد
                </td>
              </tr>
            ) : (
              rows.map((r: Row) => (
                <tr key={r.invoiceId} className="border-t">
                  <td className="p-2 font-mono">{r.invoiceNumber}</td>
                  <td className="p-2 font-mono text-muted-foreground">{r.offlineReceiptNumber ?? "—"}</td>
                  <td className="p-2">{branchName(r.branchId)}</td>
                  <td className="p-2 text-xs">{fmtDateTime(r.capturedAt)}</td>
                  <td className="p-2 text-xs">{fmtDateTime(r.syncedAt)}</td>
                  <td className="p-2">{r.replayLagMinutes != null ? `${r.replayLagMinutes} د` : "—"}</td>
                  <td className="p-2 font-semibold">{fmtIQD(r.total)} د.ع</td>
                  <td className="p-2">
                    {r.lateSynced ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                        <AlertTriangle aria-hidden className="ms-1 inline size-3" />
                        مُزامنة بعد الإغلاق
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollTableShell>
    </ReportShell>
  );
}
