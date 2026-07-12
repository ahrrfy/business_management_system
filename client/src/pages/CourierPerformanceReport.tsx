// أداء المناديب / جهات التوصيل — من الأنشط؟ من الأعلى تحصيلاً؟ من الأعلى معدّل تعذّر؟
// لطلبات المتجر الإلكتروني (COD) خلال فترة بتاريخ الطلب: مُسنَد/مُسلَّم/قيد التوصيل/متعذّر +
// قيمة المُسلَّم + COD المُحصَّل + معدّل التعذّر + العهدة القائمة. عرض + تصدير Excel + طباعة A4.
import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type Row = RouterOutputs["reports"]["courierPerformance"]["rows"][number];

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const dateCls = selectCls;

const NOTE =
  "الأرقام لطلبات المتجر الإلكتروني (COD) المُسنَدة لكل جهة، حسب تاريخ الطلب في الفترة. «المتعذّر» = طلبٌ سجّل له المندوب «تعذّر التسليم» (أُعيدت بضاعته وأُلغي). معدّل التعذّر = المتعذّر ÷ (المُسلَّم + المتعذّر). «العهدة القائمة» لقطة لحظية للنقد المُحصَّل ولم يُورَّد بعد (لا تخصّ الفترة).";

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return ymdLocal(d);
}

const PARTY_TYPE_LABEL: Record<string, string> = { INDIVIDUAL: "مندوب", COMPANY: "شركة توصيل" };

export default function CourierPerformanceReport() {
  const [from, setFrom] = useState<string>(defaultFrom);
  const [to, setTo] = useState<string>(() => ymdLocal(new Date()));
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.courierPerformance.useQuery(
    { from, to, branchId: branchId ? Number(branchId) : undefined },
    { staleTime: 60_000 },
  );

  const rows = q.data?.rows ?? [];
  const summary = q.data?.summary;
  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  const kpis: KpiItem[] = summary
    ? [
        { label: "جهات نشطة", value: fmtAr(summary.parties), tone: "info", hint: "في الفترة" },
        { label: "مُسلَّمة", value: fmtAr(summary.delivered), tone: "positive", hint: `قيد التوصيل ${fmtAr(summary.inTransit)}` },
        { label: "متعذّرة", value: fmtAr(summary.failed), tone: summary.failed > 0 ? "negative" : "default", hint: `معدّل ${summary.failRate}%` },
        { label: "COD المُحصَّل", value: formatIqd(summary.codCollected), tone: "info" },
        { label: "عهدة قائمة الآن", value: formatIqd(summary.custodyOutstanding), tone: Number(summary.custodyOutstanding) > 0 ? "warning" : "default" },
      ]
    : [];

  function onExport() {
    exportRows(rows, {
      filename: `أداء-المناديب${branchId ? `-${branchLabel}` : ""}`,
      title: "أداء المناديب / جهات التوصيل",
      meta: [
        { label: "الفترة", value: `${from} — ${to}` },
        { label: "الفرع", value: branchLabel },
        { label: "تاريخ الإصدار", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "partyName", header: "الجهة" },
        { key: "partyType", header: "النوع", map: (r) => PARTY_TYPE_LABEL[r.partyType] ?? r.partyType },
        { key: "assigned", header: "مُسنَد", map: (r) => r.assigned },
        { key: "delivered", header: "مُسلَّم", map: (r) => r.delivered },
        { key: "inTransit", header: "قيد التوصيل", map: (r) => r.inTransit },
        { key: "failed", header: "متعذّر", map: (r) => r.failed },
        { key: "failRate", header: "معدّل التعذّر %", map: (r) => r.failRate },
        { key: "deliveredValue", header: "قيمة المُسلَّم", money: true, map: (r) => Number(r.deliveredValue) },
        { key: "codCollected", header: "COD المُحصَّل", money: true, map: (r) => Number(r.codCollected) },
        { key: "custodyOutstanding", header: "عهدة قائمة", money: true, map: (r) => Number(r.custodyOutstanding) },
        { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
      ],
      totalsRow: summary
        ? {
            partyName: "الإجمالي",
            assigned: summary.assigned,
            delivered: summary.delivered,
            inTransit: summary.inTransit,
            failed: summary.failed,
            deliveredValue: Number(summary.deliveredValue),
            codCollected: Number(summary.codCollected),
            custodyOutstanding: Number(summary.custodyOutstanding),
          }
        : undefined,
    });
  }

  function onPrint() {
    printReportDoc({
      title: "أداء المناديب / جهات التوصيل",
      note: NOTE,
      headerExtra: [
        { label: "الفترة", value: `${from} — ${to}` },
        { label: "الفرع", value: branchLabel },
        { label: "كما في", value: fmtDate(new Date()) },
      ],
      columns: [
        { key: "party", label: "الجهة" },
        { key: "type", label: "النوع" },
        { key: "assigned", label: "مُسنَد", align: "left" },
        { key: "delivered", label: "مُسلَّم", align: "left" },
        { key: "failed", label: "متعذّر", align: "left" },
        { key: "rate", label: "معدّل %", align: "left" },
        { key: "cod", label: "COD المُحصَّل", align: "left" },
        { key: "custody", label: "عهدة قائمة", align: "left" },
      ],
      rows: rows.map((r) => ({
        party: r.partyName,
        type: PARTY_TYPE_LABEL[r.partyType] ?? r.partyType,
        assigned: fmtAr(r.assigned),
        delivered: fmtAr(r.delivered),
        failed: r.failed > 0 ? fmtAr(r.failed) : "—",
        rate: `${r.failRate}%`,
        cod: fmtAr(r.codCollected),
        custody: Number(r.custodyOutstanding) > 0 ? fmtAr(r.custodyOutstanding) : "—",
      })),
      summary: summary
        ? [
            { label: "عدد الجهات", value: fmtAr(summary.parties) },
            { label: "المُسلَّم", value: fmtAr(summary.delivered) },
            { label: "COD المُحصَّل", value: formatIqd(summary.codCollected), large: true, bold: true },
          ]
        : undefined,
    });
  }

  return (
    <ReportShell
      title="أداء المناديب / جهات التوصيل"
      description="أداء توصيل طلبات المتجر — الأنشط، الأعلى تحصيلاً، والأعلى معدّل تعذّر."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!rows.length}
      printDisabled={!rows.length}
      filters={
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">من</label>
            <input type="date" className={dateCls} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">إلى</label>
            <input type="date" className={dateCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <LoadingState />
          ) : (
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="p-2.5 text-right font-medium">الجهة</th>
                    <th className="p-2.5 text-right font-medium">النوع</th>
                    <th className="p-2.5 text-right font-medium">مُسنَد</th>
                    <th className="p-2.5 text-right font-medium">مُسلَّم</th>
                    <th className="p-2.5 text-right font-medium">قيد التوصيل</th>
                    <th className="p-2.5 text-right font-medium">متعذّر</th>
                    <th className="p-2.5 text-right font-medium">معدّل التعذّر</th>
                    <th className="p-2.5 text-right font-medium">قيمة المُسلَّم</th>
                    <th className="p-2.5 text-right font-medium">COD المُحصَّل</th>
                    <th className="p-2.5 text-right font-medium">عهدة قائمة</th>
                  </tr>
                </thead>
                <tbody>
                  {!rows.length ? (
                    <TableEmptyRow colSpan={10} message="لا جهات توصيل نشطة في هذا النطاق." />
                  ) : rows.map((r) => (
                    <tr key={r.partyId} className="border-b last:border-0 hover:bg-accent/40">
                      <td className="p-2.5 text-right font-medium">
                        {r.partyName}
                        {!r.isActive && <span className="ms-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">معطَّلة</span>}
                        {r.linkedUser && <div className="text-[11px] text-muted-foreground">{r.linkedUser}</div>}
                      </td>
                      <td className="p-2.5 text-right text-muted-foreground">{PARTY_TYPE_LABEL[r.partyType] ?? r.partyType}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.assigned)}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-positive" dir="ltr">{fmtAr(r.delivered)}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{r.inTransit > 0 ? fmtAr(r.inTransit) : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums text-money-negative" dir="ltr">{r.failed > 0 ? fmtAr(r.failed) : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{Number(r.failRate) > 0 ? `${r.failRate}%` : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums text-muted-foreground" dir="ltr">{fmtAr(r.deliveredValue)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{fmtAr(r.codCollected)}</td>
                      <td className="p-2.5 text-right tabular-nums" dir="ltr">{Number(r.custodyOutstanding) > 0 ? fmtAr(r.custodyOutstanding) : "—"}</td>
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
