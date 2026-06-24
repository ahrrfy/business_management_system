// الميزانية العمومية المبسّطة (لقطة) — أصول / خصوم / حقوق ملكية (مشتقّة).
// عرض + Excel + طباعة A4. ⚠️ مبسّطة: النقد تقديريّ، الأصول بالتكلفة، حقوق الملكية مشتقّة.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/PageState";
import { fmtAr, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Pos = RouterOutputs["reports"]["financialPosition"];

const NOTE =
  "ميزانية مبسّطة/مشتقّة (بانتظار دليل حسابات كامل): النقد تقديريّ (صافي المقبوضات)، الأصول بالتكلفة (بلا إهلاك متراكم)، حقوق الملكية = الأصول − الخصوم. الذمم على مستوى الشركة؛ النقد والمخزون حسب الفرع.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function BalanceSheet() {
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.financialPosition.useQuery({ branchId: branchId ? Number(branchId) : undefined });
  const p = q.data;

  const sections = useMemo(() => {
    if (!p) return null;
    const assets = [
      { label: "النقد (تقديريّ)", v: p.cash },
      { label: "الذمم المدينة (عملاء)", v: p.arDebit },
      { label: "سُلف للموردين", v: p.apDebit },
      { label: "المخزون (بالتكلفة)", v: p.inventory },
      { label: "الأصول الثابتة (بالتكلفة)", v: p.fixedAssets },
    ].filter((r) => D(r.v).gt(0));
    const liabilities = [
      { label: "الذمم الدائنة (موردون)", v: p.apCredit },
      { label: "سُلف العملاء", v: p.arCredit },
      // FIN-05: عرابين طلبات خدمة العملاء غير المُسلَّمة — التزامٌ يقابل النقد الداخل (الخدمة لم تُنجَز بعد).
      { label: "سُلف عملاء (عرابين طلبات خدمة)", v: p.customerAdvances },
    ].filter((r) => D(r.v).gt(0));
    return { assets, liabilities };
  }, [p]);

  const kpis: KpiItem[] = p
    ? [
        { label: "إجمالي الأصول", value: fmtAr(p.totalAssets), tone: "info" },
        { label: "إجمالي الخصوم", value: fmtAr(p.totalLiabilities), tone: "warning" },
        { label: "حقوق الملكية", value: fmtAr(p.equity), tone: D(p.equity).gte(0) ? "positive" : "negative" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل (الشركة)";

  function flatRows() {
    if (!p || !sections) return [] as { label: string; amount: string }[];
    return [
      { label: "الأصول", amount: "" },
      ...sections.assets.map((r) => ({ label: `— ${r.label}`, amount: p ? r.v : "" })),
      { label: "إجمالي الأصول", amount: p.totalAssets },
      { label: "الخصوم", amount: "" },
      ...sections.liabilities.map((r) => ({ label: `— ${r.label}`, amount: r.v })),
      { label: "إجمالي الخصوم", amount: p.totalLiabilities },
      { label: "حقوق الملكية (مشتقّة)", amount: p.equity },
    ];
  }

  function onExport() {
    exportRows(flatRows(), {
      filename: "الميزانية-العمومية",
      columns: [
        { key: "label", header: "البند" },
        { key: "amount", header: "القيمة", map: (r) => (r.amount === "" ? "" : Number(r.amount)) },
      ],
    });
  }

  function onPrint() {
    if (!p) return;
    printReportDoc({
      title: "الميزانية العمومية",
      headerExtra: [
        { label: "كما في", value: new Date().toLocaleDateString("ar-IQ-u-nu-latn") },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "label", label: "البند" },
        { key: "amount", label: "القيمة", align: "left" },
      ],
      rows: flatRows().map((r) => ({ label: r.label, amount: r.amount === "" ? "" : fmtAr(r.amount) })),
      showIndex: false,
      summary: [
        { label: "إجمالي الأصول", value: fmtAr(p.totalAssets) },
        { label: "إجمالي الخصوم", value: fmtAr(p.totalLiabilities) },
        { label: "حقوق الملكية", value: fmtAr(p.equity), large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="الميزانية العمومية"
      description="لقطة مبسّطة: أصول / خصوم / حقوق ملكية."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!p}
      printDisabled={!p}
      filters={
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">الفرع</label>
          <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">الكل (الشركة)</option>
            {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
          </select>
        </div>
      }
    >
      {q.isLoading || !p || !sections ? (
        <Card><CardContent className="p-0">{q.isLoading ? <LoadingState /> : <div className="p-8 text-center text-sm text-muted-foreground">لا بيانات.</div>}</CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="الأصول" rows={sections.assets} total={p.totalAssets} totalLabel="إجمالي الأصول" tone="emerald" />
          <div className="space-y-4">
            <SectionCard title="الخصوم" rows={sections.liabilities} total={p.totalLiabilities} totalLabel="إجمالي الخصوم" tone="amber" />
            <Card>
              <CardContent className="flex items-center justify-between p-4">
                <span className="font-bold">حقوق الملكية (مشتقّة)</span>
                <span className={`text-xl font-bold tabular-nums ${D(p.equity).gte(0) ? "text-money-positive" : "text-money-negative"}`} dir="ltr">{fmtAr(p.equity)}</span>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </ReportShell>
  );
}

function SectionCard({ title, rows, total, totalLabel, tone }: {
  title: string; rows: { label: string; v: string }[]; total: string; totalLabel: string; tone: "emerald" | "amber";
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className={`px-4 py-2.5 font-semibold border-b ${tone === "emerald" ? "text-emerald-700" : "text-amber-700"}`}>{title}</div>
        <table className="w-full text-sm">
          <tbody>
            {rows.length === 0 ? (
              <tr><td className="p-4 text-center text-muted-foreground">—</td></tr>
            ) : rows.map((r, i) => (
              <tr key={i} className="border-b">
                <td className="p-3 text-end">{r.label}</td>
                <td className="p-3 text-right tabular-nums" dir="ltr">{fmtAr(r.v)}</td>
              </tr>
            ))}
            <tr className="font-bold bg-muted/30">
              <td className="p-3 text-end">{totalLabel}</td>
              <td className="p-3 text-right tabular-nums" dir="ltr">{fmtAr(total)}</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
