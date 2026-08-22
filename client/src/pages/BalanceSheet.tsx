// الميزانية العمومية المبسّطة (لقطة) — أصول / خصوم / حقوق ملكية (مشتقّة).
// عرض + Excel + طباعة A4. ⚠️ مبسّطة: المقبوضات مصنفة حسب وسيلة الدفع، الأصول بالتكلفة، حقوق الملكية مشتقّة.
import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr, D } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { toExcelMoney } from "@/lib/payrollAccrual";

/** اليوم YYYY-MM-DD محلياً — لا toISOString (ينزاح قرب منتصف الليل ببغداد UTC+3). */
function todayYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

type Pos = RouterOutputs["reports"]["financialPosition"];

const NOTE =
  "ميزانية مبسّطة/مشتقّة (بانتظار دليل حسابات كامل): المقبوضات المعتمدة مصنفة حسب وسيلة الدفع ولا تُعامل البطاقات والتحويلات والصكوك والمحافظ كنقد بالصندوق، الأصول بالتكلفة (بلا إهلاك متراكم)، وحقوق الملكية = الأصول − الخصوم. الذمم على مستوى الشركة؛ وسائل الدفع والمخزون حسب الفرع.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function BalanceSheet() {
  const [branchId, setBranchId] = useState<number | "">("");
  // «كما في تاريخ» — فارغ يعني اللقطة الحيّة الآن (بلا تغيير سلوكيّ افتراضاً).
  const [asOf, setAsOf] = useState("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.financialPosition.useQuery({
    branchId: branchId ? Number(branchId) : undefined,
    asOf: asOf || undefined,
  });
  const p = q.data;

  const sections = useMemo(() => {
    if (!p) return null;
    const assets = [
      { label: "النقد المقبوض فعلياً", v: p.cash },
      { label: "مقبوضات البطاقات", v: p.card },
      { label: "الصكوك المقبوضة", v: p.check },
      { label: "التحويلات المصرفية", v: p.transfer },
      { label: "المحافظ الإلكترونية", v: p.wallet },
      // مراجعة PR #495: بنودٌ يحتسبها إجمالي الأصول ولم تكن معروضةً في الجدول (فلا يجمع لمجموعه) —
      // رصيد زين وعهدة المناديب ورصيدنا لدى الصرّافين. «لا دينار بلا مسار وتبويب».
      { label: "رصيد زين (اتصالات)", v: p.telecom },
      { label: "رصيدنا لدى مزوّدي البطاقات", v: p.digitalWalletAsset },
      { label: "عهدة مناديب التوصيل (غير المدعومة بذمّة)", v: p.deliveryFloat },
      { label: "رصيدنا لدى الصرّافين", v: p.exchangeDebit },
      { label: "الذمم المدينة (عملاء)", v: p.arDebit },
      { label: "سُلف للموردين", v: p.apDebit },
      { label: "تسوية مشتريات نقدية لنا", v: p.cashPurchaseClearingDebit },
      { label: "المخزون (بالتكلفة)", v: p.inventory },
      { label: "الأصول الثابتة (بالتكلفة)", v: p.fixedAssets },
      { label: "سلف مستحقة على الموظفين", v: p.employeeAdvanceReceivable },
      { label: "مستحق لنا على الفروع الأخرى", v: p.dueFromBranches },
    ].filter((r) => D(r.v).gt(0));
    const liabilities = [
      { label: "الذمم الدائنة (موردون)", v: p.apCredit },
      { label: "تسوية مشتريات نقدية معلّقة", v: p.cashPurchaseClearingCredit },
      { label: "سُلف العملاء", v: p.arCredit },
      // FIN-05: عرابين طلبات خدمة العملاء غير المُسلَّمة — التزامٌ يقابل النقد الداخل (الخدمة لم تُنجَز بعد).
      // مراجعة PR #495: يشمل عرابين الطلبات المحفوظة المفتوحة (تُفصَّل في السطر التالي).
      { label: "سُلف عملاء (عرابين طلبات خدمة)", v: p.customerAdvances },
      { label: "ما نَدين به للصرّافين", v: p.exchangeCredit },
      // ١٠/٨ — أجرة توصيل قُبضت في الدرج أمانةً للمندوب ولم تُصرف له بعد (نقدها ضمن «النقد»).
      { label: "أمانات أجور توصيل معلّقة", v: p.deliveryFeeHeldLiability },
      { label: "أجور توصيل مكتسبة غير مدفوعة", v: p.deliveryFeeDueLiability },
      { label: "صافي رواتب مستحق للموظفين", v: p.accruedSalaryLiability },
      { label: "ضريبة رواتب مستحقة التحويل", v: p.payrollTaxPayable },
      { label: "ضمان اجتماعي مستحق التحويل", v: p.socialSecurityPayable },
      { label: "مخصص نهاية الخدمة", v: p.eosProvision },
      { label: "مستحق علينا للفروع الأخرى", v: p.dueToBranches },
    ].filter((r) => !D(r.v).isZero());
    return { assets, liabilities };
  }, [p]);

  // مراجعة PR #495 — إفصاحٌ نصّي عن البندين اللذين يسهل أن يُقرآ خطأً: الجزء المستبعَد من عهدة
  // المناديب (لأنّه ذمّةُ عميلٍ محسوبةٌ سلفاً — منعُ ازدواج)، وحصّة عرابين الطلبات المحفوظة.
  const disclosure = p
    ? [
        D(p.deliveryFloatCustomerBacked).gt(0)
          ? `من عهدة المناديب ${fmtAr(p.deliveryFloatCustomerBacked)} مدعومةٌ بذمّة عميلٍ مسجَّل ⇒ معروضةٌ ضمن «الذمم المدينة» ولا تُحتسب أصلاً مرّتين.`
          : "",
        D(p.draftAdvances).gt(0)
          ? `ومن «سُلف العملاء» ${fmtAr(p.draftAdvances)} عرابينُ طلباتٍ محفوظةٍ ما زالت مفتوحة.`
          : "",
      ].filter(Boolean).join(" ")
    : "";
  const fullNote = [NOTE, disclosure, p?.historicalNote ?? "", p?.interbranchNote ?? ""].filter(Boolean).join(" ");

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
        { key: "amount", header: "القيمة", map: (r) => (r.amount === "" ? "" : toExcelMoney(r.amount)) },
      ],
    });
  }

  function onPrint() {
    if (!p) return;
    printReportDoc({
      title: "الميزانية العمومية",
      headerExtra: [
        { label: "كما في", value: p.asOf ? fmtDate(new Date(`${p.asOf}T00:00:00`)) : fmtDate(new Date()) },
        { label: "الفرع", value: branchLabel },
      ],
      note: fullNote,
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
      note={fullNote}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!p}
      printDisabled={!p}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">الكل (الشركة)</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">كما في تاريخ</label>
            <Input type="date" dir="ltr" value={asOf} max={todayYmd()} onChange={(e) => setAsOf(e.target.value)} className="h-9 w-40" />
          </div>
        </div>
      }
    >
      {q.isLoading || q.isError || !p || !sections ? (
        <Card><CardContent className="p-0">{q.isLoading ? <LoadingState /> : q.isError ? <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} /> : <div className="p-8 text-center text-sm text-muted-foreground">لا بيانات.</div>}</CardContent></Card>
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
