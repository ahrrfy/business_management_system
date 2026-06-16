// ميزان المراجعة المبسّط — أرصدة بصيغة مدين/دائن (لقطة) تتوازن بناءً (حقوق الملكية مشتقّة).
// عرض + Excel + طباعة A4. يشارك endpoint المركز المالي مع الميزانية العمومية.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { fmtAr, D } from "@/lib/money";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

type Pos = RouterOutputs["reports"]["financialPosition"];

const NOTE =
  "ميزان مبسّط/مشتقّ: النقد تقديريّ، الأصول بالتكلفة، حقوق الملكية = الأصول − الخصوم (يجعل الميزان متوازناً). الذمم على مستوى الشركة؛ النقد والمخزون حسب الفرع.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function buildRows(p: Pos) {
  return [
    { label: "النقد (تقديريّ)", debit: p.cash, credit: "0" },
    { label: "الذمم المدينة (عملاء)", debit: p.arDebit, credit: "0" },
    { label: "سُلف للموردين", debit: p.apDebit, credit: "0" },
    { label: "المخزون (بالتكلفة)", debit: p.inventory, credit: "0" },
    { label: "الأصول الثابتة (بالتكلفة)", debit: p.fixedAssets, credit: "0" },
    { label: "الذمم الدائنة (موردون)", debit: "0", credit: p.apCredit },
    { label: "سُلف العملاء", debit: "0", credit: p.arCredit },
    { label: "حقوق الملكية (مشتقّة)", debit: "0", credit: p.equity },
  ].filter((r) => D(r.debit).gt(0) || D(r.credit).gt(0));
}

export default function TrialBalance() {
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.financialPosition.useQuery({ branchId: branchId ? Number(branchId) : undefined });
  const p = q.data;
  const rows = useMemo(() => (p ? buildRows(p) : []), [p]);

  const totalDebit = p?.totalAssets ?? "0";
  const totalCredit = p ? D(p.totalLiabilities).add(D(p.equity)).toString() : "0";

  const kpis: KpiItem[] = p
    ? [
        { label: "إجمالي المدين", value: fmtAr(totalDebit), tone: "info" },
        { label: "إجمالي الدائن", value: fmtAr(totalCredit), tone: "info" },
        { label: "التوازن", value: D(totalDebit).sub(D(totalCredit)).abs().lt(D("0.01")) ? "متوازن ✓" : "غير متوازن", tone: "positive" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل (الشركة)";

  function onExport() {
    exportRows(rows, {
      filename: "ميزان-المراجعة",
      columns: [
        { key: "label", header: "الحساب" },
        { key: "debit", header: "مدين", map: (r) => Number(r.debit) },
        { key: "credit", header: "دائن", map: (r) => Number(r.credit) },
      ],
    });
  }

  function onPrint() {
    if (!p) return;
    printReportDoc({
      title: "ميزان المراجعة",
      headerExtra: [
        { label: "كما في", value: new Date().toLocaleDateString("ar-IQ-u-nu-latn") },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      columns: [
        { key: "label", label: "الحساب" },
        { key: "debit", label: "مدين", align: "left" },
        { key: "credit", label: "دائن", align: "left" },
      ],
      rows: rows.map((r) => ({
        label: r.label,
        debit: D(r.debit).gt(0) ? fmtAr(r.debit) : "—",
        credit: D(r.credit).gt(0) ? fmtAr(r.credit) : "—",
      })),
      showIndex: false,
      summary: [
        { label: "إجمالي المدين", value: fmtAr(totalDebit) },
        { label: "إجمالي الدائن", value: fmtAr(totalCredit), large: true, bold: true },
      ],
    });
  }

  return (
    <ReportShell
      title="ميزان المراجعة"
      description="أرصدة الحسابات بصيغة مدين/دائن (لقطة)."
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
      <Card>
        <CardContent className="p-0">
          {q.isLoading || !p ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{q.isLoading ? "جارٍ التحميل…" : "لا بيانات."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-3 text-right font-medium">الحساب</th>
                  <th className="p-3 text-left font-medium">مدين</th>
                  <th className="p-3 text-left font-medium">دائن</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-3 text-right">{r.label}</td>
                    <td className="p-3 text-left tabular-nums" dir="ltr">{D(r.debit).gt(0) ? fmtAr(r.debit) : "—"}</td>
                    <td className="p-3 text-left tabular-nums" dir="ltr">{D(r.credit).gt(0) ? fmtAr(r.credit) : "—"}</td>
                  </tr>
                ))}
                <tr className="font-bold bg-muted/30">
                  <td className="p-3 text-right">الإجمالي</td>
                  <td className="p-3 text-left tabular-nums" dir="ltr">{fmtAr(totalDebit)}</td>
                  <td className="p-3 text-left tabular-nums" dir="ltr">{fmtAr(totalCredit)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </ReportShell>
  );
}
