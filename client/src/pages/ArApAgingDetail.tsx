// تفصيل أعمار الذمم — فاتورةً بفاتورة (مدينة AR) / أمرَ شراء بأمر (دائنة AP).
// يكمّل تقريرَي الملخّص (أعمار الذمم المدينة/الدائنة): بدل تجميع كل عميل/مورد في صفّ، يسرد
// كل مستندٍ مستحقّ منفرداً بعدد أيّام تأخّره وشريحته ومتبقّيه — مرتّباً من الأقدم تأخّراً.
// عرض + KPIs بالشرائح + تصدير Excel + طباعة A4 (ReportShell + printReportDoc).
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";

type Side = "AR" | "AP";
type Row = RouterOutputs["reports"]["arApAgingDetail"]["rows"][number];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const SIDE_LABEL: Record<Side, string> = { AR: "ذمم مدينة (لنا)", AP: "ذمم دائنة (علينا)" };

const BUCKET_CLS: Record<string, string> = {
  "0-30": "badge-status-active",
  "31-60": "badge-stock-low",
  "61-90": "badge-stock-low",
  "90+": "badge-stock-out",
};

export default function ArApAgingDetail() {
  const [side, setSide] = useState<Side>("AR");
  const [branchId, setBranchId] = useState<number | "">("");

  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.arApAgingDetail.useQuery({
    side,
    branchId: branchId ? Number(branchId) : undefined,
  });

  const rows = q.data?.rows ?? [];
  const totals = q.data?.totals;
  const isAR = side === "AR";

  const kpis: KpiItem[] = totals
    ? [
        { label: "0–30 يوم", value: fmtAr(totals.d0_30), tone: "positive" },
        { label: "31–60 يوم", value: fmtAr(totals.d31_60), tone: "warning" },
        { label: "61–90 يوم", value: fmtAr(totals.d61_90), tone: "warning" },
        { label: "أكثر من 90", value: fmtAr(totals.d91p), tone: "negative" },
        { label: `الإجمالي (${totals.count})`, value: fmtAr(totals.unpaid), tone: "info" },
      ]
    : [];

  const branchLabel = useMemo(
    () => (branchId ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId) : "الكل"),
    [branchId, branches.data],
  );

  const refHref = (r: Row) => (isAR ? `/invoices/${r.id}` : `/purchases/${r.id}`);

  function onExport() {
    exportRows(rows, {
      filename: `تفصيل-أعمار-${isAR ? "الذمم-المدينة" : "الذمم-الدائنة"}`,
      columns: [
        { key: "number", header: isAR ? "رقم الفاتورة" : "رقم أمر الشراء" },
        { key: "partyName", header: isAR ? "العميل" : "المورد" },
        { key: "date", header: "التاريخ" },
        ...(isAR ? [{ key: "dueDate", header: "الاستحقاق", map: (r: Row) => r.dueDate ?? "" }] : []),
        { key: "daysOverdue", header: "أيام التأخّر", map: (r) => r.daysOverdue },
        { key: "bucket", header: "الشريحة" },
        { key: "unpaid", header: "المتبقّي", map: (r) => Number(r.unpaid) },
      ],
    });
  }

  function onPrint() {
    printReportDoc({
      title: isAR ? "تفصيل أعمار الذمم المدينة" : "تفصيل أعمار الذمم الدائنة",
      headerExtra: [
        { label: "النوع", value: SIDE_LABEL[side] },
        { label: "الفرع", value: branchLabel },
      ],
      columns: [
        { key: "number", label: isAR ? "رقم الفاتورة" : "رقم الأمر" },
        { key: "party", label: isAR ? "العميل" : "المورد" },
        { key: "date", label: "التاريخ" },
        { key: "days", label: "أيام التأخّر", align: "left" },
        { key: "bucket", label: "الشريحة" },
        { key: "unpaid", label: "المتبقّي", align: "left" },
      ],
      rows: rows.map((r) => ({
        number: r.number,
        party: r.partyName,
        date: r.date,
        days: String(r.daysOverdue),
        bucket: r.bucket,
        unpaid: fmtAr(r.unpaid),
      })),
      summary: totals
        ? [
            { label: "0–30", value: fmtAr(totals.d0_30) },
            { label: "31–60", value: fmtAr(totals.d31_60) },
            { label: "61–90", value: fmtAr(totals.d61_90) },
            { label: "+90", value: fmtAr(totals.d91p) },
            { label: "إجمالي المتبقّي", value: fmtAr(totals.unpaid), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="تفصيل أعمار الذمم"
      description="كل مستندٍ مستحقّ منفرداً (فاتورة/أمر شراء) بعدد أيّام تأخّره وشريحته العمرية ومتبقّيه."
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">النوع</label>
            <select
              className={selectCls}
              value={side}
              onChange={(e) => setSide(e.target.value as Side)}
            >
              <option value="AR">مدينة — لنا على العملاء</option>
              <option value="AP">دائنة — علينا للموردين</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">الكل</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : q.error ? (
            <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
          ) : !rows.length ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              لا مستندات مستحقّة في هذا النطاق.
            </p>
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">{isAR ? "رقم الفاتورة" : "رقم أمر الشراء"}</th>
                    <th className="p-2.5 text-right font-medium">{isAR ? "العميل" : "المورد"}</th>
                    <th className="p-2.5 text-right font-medium">التاريخ</th>
                    {isAR && <th className="p-2.5 text-right font-medium">الاستحقاق</th>}
                    <th className="p-2.5 text-right font-medium">أيام التأخّر</th>
                    <th className="p-2.5 text-center font-medium">الشريحة</th>
                    <th className="p-2.5 text-right font-medium">المتبقّي</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right">
                        <Link href={refHref(r)} className="text-primary underline-offset-2 hover:underline">
                          {r.number}
                        </Link>
                      </td>
                      <td className="p-2.5 text-right">{r.partyName}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.date}</td>
                      {isAR && (
                        <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">
                          {r.dueDate ?? "—"}
                        </td>
                      )}
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{r.daysOverdue}</td>
                      <td className="p-2.5 text-center">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${BUCKET_CLS[r.bucket] ?? "bg-muted text-muted-foreground"}`}>
                          {r.bucket}
                        </span>
                      </td>
                      <td className="p-2.5 text-right tabular-nums font-semibold" dir="ltr">{fmtAr(r.unpaid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTableShell>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
