// رقيب الشذوذ — ٦ كواشف حتمية لمنع تسرّب الأموال (بلا أي ذكاء اصطناعي):
// بيع دون الكلفة (لقطة الكلفة التاريخية) · طفرة خصومات لكل كاشير · تركّز المرتجعات ·
// عجوزات الورديات · عكس السندات · سلامة تسلسل الترقيم (كاشف عبث بقاعدة البيانات).
// الجداول تعرض الجميع والأعلام ترتّب لا تحجب. تصدير Excel متعدد الأوراق (ورقة لكل كاشف).
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, presetRange, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { fmtAr } from "@/lib/money";
import { exportSheets, type SheetSpec } from "@/lib/export";
import { cn } from "@/lib/utils";

type AW = RouterOutputs["reports"]["anomalyWatch"];

const NOTE =
  "كواشف حتمية على بيانات النظام كما هي: «دون الكلفة» يقارن بلقطة الكلفة وقت البيع لا الكلفة الحالية؛ " +
  "«معالجو الإرجاع» من سجلّ التدقيق (قد ينقص عند تعذّر تسجيله)؛ أي فجوة تسلسل تعني حذف صفوف من قاعدة البيانات مباشرةً (مستحيلة من التطبيق).";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** فترة افتراضية: آخر ٧ أيام (تقرير أسبوعي بطبيعته). */
const WEEK_PERIOD: PeriodValue = { ...presetRange("week"), preset: "week" };

const thCls = "p-3 text-right font-medium";
const tdCls = "p-3 text-right";
const numCls = "p-3 text-right tabular-nums";

function FlagCell({ flagged }: { flagged: boolean }) {
  if (!flagged) return <td className={tdCls} />;
  return (
    <td className={tdCls}>
      <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
        <AlertTriangle aria-hidden className="size-3" />
        مؤشر
      </span>
    </td>
  );
}

function SectionCard({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{title}</span>
          {typeof count === "number" && count > 0 && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive tabular-nums">
              {count}
            </span>
          )}
        </CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">{children}</CardContent>
    </Card>
  );
}

export default function AnomalyWatch() {
  const [period, setPeriod] = useState<PeriodValue>(WEEK_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.anomalyWatch.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const aw: AW | undefined = q.data;

  const kpis: KpiItem[] = aw
    ? [
        { label: "أسطر بيع دون الكلفة", value: String(aw.kpis.belowCostLines), tone: aw.kpis.belowCostLines > 0 ? "negative" : "positive" },
        { label: "خسارة البيع دون الكلفة", value: fmtAr(aw.kpis.belowCostLoss), tone: aw.kpis.belowCostLines > 0 ? "negative" : "default" },
        { label: "كاشيرية بخصم مُعلَّم", value: String(aw.kpis.flaggedDiscountCashiers), tone: aw.kpis.flaggedDiscountCashiers > 0 ? "warning" : "positive" },
        { label: "بائعون بمرتجع مُعلَّم", value: String(aw.kpis.flaggedReturnSellers), tone: aw.kpis.flaggedReturnSellers > 0 ? "warning" : "positive" },
        { label: "كاشيرية بعجوزات", value: String(aw.kpis.flaggedShortageCashiers), tone: aw.kpis.flaggedShortageCashiers > 0 ? "warning" : "positive" },
        { label: "سندات معكوسة", value: String(aw.kpis.reversedVouchers), tone: aw.kpis.reversedVouchers > 0 ? "info" : "positive" },
        { label: "أيام بفجوة تسلسل", value: String(aw.kpis.sequenceGapDays), tone: aw.kpis.sequenceGapDays > 0 ? "negative" : "positive" },
      ]
    : [];

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  function onExport() {
    if (!aw) return;
    const meta = [
      { label: "الفترة", value: `${aw.from} — ${aw.to}` },
      { label: "الفرع", value: branchLabel },
    ];
    const sheets: SheetSpec[] = [
      {
        sheetName: "دون الكلفة — كاشيرية",
        title: "بيع دون الكلفة حسب الكاشير",
        meta,
        columns: [
          { key: "userName", header: "الكاشير" },
          { key: "lineCount", header: "الأسطر" },
          { key: "lossValue", header: "الخسارة", money: true, map: (r: any) => Number(r.lossValue) },
        ],
        rows: aw.belowCost.cashiers as any[],
      },
      {
        sheetName: "دون الكلفة — أسوأ الأسطر",
        title: "أسوأ أسطر البيع دون الكلفة",
        meta,
        columns: [
          { key: "invoiceNumber", header: "الفاتورة" },
          { key: "invoiceDate", header: "التاريخ" },
          { key: "userName", header: "الكاشير" },
          { key: "productName", header: "الصنف" },
          { key: "quantity", header: "الكمية" },
          { key: "lineTotal", header: "صافي السطر", money: true, map: (r: any) => Number(r.lineTotal) },
          { key: "lineCost", header: "كلفة السطر", money: true, map: (r: any) => Number(r.lineCost) },
          { key: "lossValue", header: "الخسارة", money: true, map: (r: any) => Number(r.lossValue) },
        ],
        rows: aw.belowCost.worstLines as any[],
      },
      {
        sheetName: "الخصومات",
        title: `الخصومات اليدوية حسب الكاشير (متوسط النطاق ${aw.discounts.scopeAvgRatePct}%)`,
        meta,
        columns: [
          { key: "userName", header: "الكاشير" },
          { key: "invoiceCount", header: "الفواتير" },
          { key: "grossTotal", header: "البيع قبل الخصم", money: true, map: (r: any) => Number(r.grossTotal) },
          { key: "manualDiscount", header: "الخصم اليدوي", money: true, map: (r: any) => Number(r.manualDiscount) },
          { key: "discountRatePct", header: "النسبة %" },
          { key: "promoDiscount", header: "خصم العروض", money: true, map: (r: any) => Number(r.promoDiscount) },
          { key: "flagged", header: "مؤشر", map: (r: any) => (r.flagged ? "نعم" : "") },
        ],
        rows: aw.discounts.rows as any[],
      },
      {
        sheetName: "المرتجعات — البائعون",
        title: `المرتجعات على بائع الفاتورة (متوسط النطاق ${aw.returns.scopeAvgRatePct}%)`,
        meta,
        columns: [
          { key: "userName", header: "البائع" },
          { key: "invoiceCount", header: "الفواتير" },
          { key: "salesTotal", header: "المبيعات", money: true, map: (r: any) => Number(r.salesTotal) },
          { key: "returnedTotal", header: "المرتجع", money: true, map: (r: any) => Number(r.returnedTotal) },
          { key: "returnRatePct", header: "النسبة %" },
          { key: "flagged", header: "مؤشر", map: (r: any) => (r.flagged ? "نعم" : "") },
        ],
        rows: aw.returns.sellers as any[],
      },
      {
        sheetName: "العجوزات",
        title: "عجوزات/فوائض الورديات حسب الكاشير",
        meta,
        columns: [
          { key: "userName", header: "الكاشير" },
          { key: "closedShifts", header: "ورديات مغلقة" },
          { key: "shortageShifts", header: "ورديات عجز" },
          { key: "totalShortage", header: "إجمالي العجز", money: true, map: (r: any) => Number(r.totalShortage) },
          { key: "totalSurplus", header: "إجمالي الفائض", money: true, map: (r: any) => Number(r.totalSurplus) },
          { key: "flagged", header: "مؤشر", map: (r: any) => (r.flagged ? "نعم" : "") },
        ],
        rows: aw.shiftShortages.rows as any[],
      },
      {
        sheetName: "السندات المعكوسة",
        title: "السندات المعكوسة في الفترة",
        meta,
        columns: [
          { key: "voucherNumber", header: "السند" },
          { key: "direction", header: "الاتجاه", map: (r: any) => (r.direction === "OUT" ? "صرف" : "قبض") },
          { key: "amount", header: "المبلغ", money: true, map: (r: any) => Number(r.amount) },
          { key: "createdByName", header: "منشئه" },
          { key: "reversedByName", header: "عاكسه" },
          { key: "reversedAt", header: "وقت العكس" },
        ],
        rows: aw.reversedVouchers.rows as any[],
      },
      {
        sheetName: "فجوات التسلسل",
        title: "فجوات تسلسل ترقيم الفواتير (كاشف عبث)",
        meta,
        columns: [
          { key: "branchName", header: "الفرع" },
          { key: "day", header: "اليوم" },
          { key: "actualCount", header: "الموجود" },
          { key: "maxSeq", header: "أعلى تسلسل" },
          { key: "missing", header: "المفقود" },
        ],
        rows: aw.sequenceGaps.rows as any[],
      },
    ];
    exportSheets(`رقيب-الشذوذ-${aw.from}-${aw.to}`, sheets);
  }

  return (
    <ReportShell
      title="رقيب الشذوذ"
      description="كواشف حتمية لمنع تسرّب الأموال: بيع دون الكلفة، خصومات، مرتجعات، عجوزات، عكوس، وسلامة الترقيم."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      exportDisabled={!aw}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
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
      {q.isLoading ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState message={q.error?.message} onRetry={() => q.refetch()} />
      ) : !aw ? (
        <p className="p-8 text-center text-sm text-muted-foreground">لا بيانات.</p>
      ) : (
        <div className="space-y-4">
          {/* D6 — الأخطر أولاً حين يقع */}
          {aw.sequenceGaps.rows.length > 0 && (
            <SectionCard
              title="فجوات تسلسل الترقيم — تحذير حرج"
              subtitle="الترقيم لا يثقب من التطبيق إطلاقاً؛ الفجوة تعني حذف صفوف من قاعدة البيانات مباشرةً."
              count={aw.sequenceGaps.rows.length}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className={thCls}>الفرع</th>
                    <th className={thCls}>اليوم</th>
                    <th className={thCls}>الموجود</th>
                    <th className={thCls}>أعلى تسلسل</th>
                    <th className={thCls}>المفقود</th>
                  </tr>
                </thead>
                <tbody>
                  {aw.sequenceGaps.rows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0 bg-destructive/5">
                      <td className={tdCls}>{r.branchName}</td>
                      <td className={numCls} dir="ltr">{r.day}</td>
                      <td className={numCls} dir="ltr">{r.actualCount}</td>
                      <td className={numCls} dir="ltr">{r.maxSeq}</td>
                      <td className={cn(numCls, "font-bold text-destructive")} dir="ltr">{r.missing}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          )}

          {/* D1 — بيع دون الكلفة */}
          <SectionCard
            title="بيع دون الكلفة"
            subtitle="أسطر بيع صافيها أقل من كلفتها وقت البيع (لقطة الكلفة التاريخية). الهدايا مجهولة الكلفة مستثناة."
            count={aw.kpis.belowCostLines}
          >
            {aw.belowCost.cashiers.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">لا بيع دون الكلفة في الفترة.</p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className={thCls}>الكاشير</th>
                      <th className={thCls}>الأسطر</th>
                      <th className={thCls}>الخسارة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aw.belowCost.cashiers.map((r, i) => (
                      <tr key={i} className="border-b last:border-0 bg-destructive/5">
                        <td className={tdCls}>{r.userName}</td>
                        <td className={numCls} dir="ltr">{r.lineCount}</td>
                        <td className={cn(numCls, "text-money-negative font-medium")} dir="ltr">{fmtAr(r.lossValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">أسوأ الأسطر (أعلى ١٠ خسارةً)</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className={thCls}>الفاتورة</th>
                      <th className={thCls}>التاريخ</th>
                      <th className={thCls}>الكاشير</th>
                      <th className={thCls}>الصنف</th>
                      <th className={thCls}>الكمية</th>
                      <th className={thCls}>صافي السطر</th>
                      <th className={thCls}>كلفته</th>
                      <th className={thCls}>الخسارة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aw.belowCost.worstLines.map((r, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className={cn(tdCls, "font-mono text-xs")} dir="ltr">{r.invoiceNumber}</td>
                        <td className={numCls} dir="ltr">{r.invoiceDate}</td>
                        <td className={tdCls}>{r.userName}</td>
                        <td className={tdCls}>{r.productName}</td>
                        <td className={numCls} dir="ltr">{fmtAr(r.quantity)}</td>
                        <td className={numCls} dir="ltr">{fmtAr(r.lineTotal)}</td>
                        <td className={numCls} dir="ltr">{fmtAr(r.lineCost)}</td>
                        <td className={cn(numCls, "text-money-negative font-medium")} dir="ltr">{fmtAr(r.lossValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </SectionCard>

          {/* D2 — الخصومات */}
          <SectionCard
            title="الخصومات اليدوية حسب الكاشير"
            subtitle={`المؤشر: نسبة ≥ ضعفَي متوسط النطاق (${aw.discounts.scopeAvgRatePct}%) و≥ ٥٪. خصم العروض آليّ ويُعرض للسياق فقط.`}
            count={aw.kpis.flaggedDiscountCashiers}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className={thCls}>الكاشير</th>
                  <th className={thCls}>الفواتير</th>
                  <th className={thCls}>البيع قبل الخصم</th>
                  <th className={thCls}>الخصم اليدوي</th>
                  <th className={thCls}>النسبة</th>
                  <th className={thCls}>خصم العروض</th>
                  <th className={thCls}></th>
                </tr>
              </thead>
              <tbody>
                {aw.discounts.rows.length === 0 ? (
                  <TableEmptyRow colSpan={7} message="لا مبيعات في الفترة." />
                ) : (
                  aw.discounts.rows.map((r, i) => (
                    <tr key={i} className={cn("border-b last:border-0", r.flagged && "bg-destructive/5")}>
                      <td className={tdCls}>{r.userName}</td>
                      <td className={numCls} dir="ltr">{r.invoiceCount}</td>
                      <td className={numCls} dir="ltr">{fmtAr(r.grossTotal)}</td>
                      <td className={numCls} dir="ltr">{fmtAr(r.manualDiscount)}</td>
                      <td className={cn(numCls, r.flagged && "font-bold text-destructive")} dir="ltr">{r.discountRatePct}%</td>
                      <td className={cn(numCls, "text-muted-foreground")} dir="ltr">{fmtAr(r.promoDiscount)}</td>
                      <FlagCell flagged={r.flagged} />
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </SectionCard>

          {/* D3 — المرتجعات */}
          <SectionCard
            title="تركّز المرتجعات"
            subtitle={`نسبة مرتجعات مبيعات كل بائع (متوسط النطاق ${aw.returns.scopeAvgRatePct}%). «معالجو الإرجاع» من سجلّ التدقيق — قد ينقص.`}
            count={aw.kpis.flaggedReturnSellers}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className={thCls}>البائع</th>
                  <th className={thCls}>الفواتير</th>
                  <th className={thCls}>المبيعات</th>
                  <th className={thCls}>المرتجع</th>
                  <th className={thCls}>النسبة</th>
                  <th className={thCls}></th>
                </tr>
              </thead>
              <tbody>
                {aw.returns.sellers.length === 0 ? (
                  <TableEmptyRow colSpan={6} message="لا مبيعات في الفترة." />
                ) : (
                  aw.returns.sellers.map((r, i) => (
                    <tr key={i} className={cn("border-b last:border-0", r.flagged && "bg-destructive/5")}>
                      <td className={tdCls}>{r.userName}</td>
                      <td className={numCls} dir="ltr">{r.invoiceCount}</td>
                      <td className={numCls} dir="ltr">{fmtAr(r.salesTotal)}</td>
                      <td className={numCls} dir="ltr">{fmtAr(r.returnedTotal)}</td>
                      <td className={cn(numCls, r.flagged && "font-bold text-destructive")} dir="ltr">{r.returnRatePct}%</td>
                      <FlagCell flagged={r.flagged} />
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {aw.returns.processors.length > 0 && (
              <>
                <p className="border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">معالجو الإرجاع (من سجلّ التدقيق)</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className={thCls}>المستخدم</th>
                      <th className={thCls}>عمليات إرجاع</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aw.returns.processors.map((r, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className={tdCls}>{r.userName}</td>
                        <td className={numCls} dir="ltr">{r.opsCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </SectionCard>

          {/* D4 — العجوزات */}
          <SectionCard
            title="عجوزات الورديات"
            subtitle="المؤشر: ورديتا عجزٍ فأكثر بالفترة أو إجمالي عجز ≥ ٢٥٬٠٠٠ د.ع. الفائض يُعرض أيضاً (قد يدل على بيع غير مسجَّل)."
            count={aw.kpis.flaggedShortageCashiers}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className={thCls}>الكاشير</th>
                  <th className={thCls}>ورديات مغلقة</th>
                  <th className={thCls}>ورديات عجز</th>
                  <th className={thCls}>إجمالي العجز</th>
                  <th className={thCls}>إجمالي الفائض</th>
                  <th className={thCls}></th>
                </tr>
              </thead>
              <tbody>
                {aw.shiftShortages.rows.length === 0 ? (
                  <TableEmptyRow colSpan={6} message="لا فروقات صندوق في الفترة." />
                ) : (
                  aw.shiftShortages.rows.map((r, i) => (
                    <tr key={i} className={cn("border-b last:border-0", r.flagged && "bg-destructive/5")}>
                      <td className={tdCls}>{r.userName}</td>
                      <td className={numCls} dir="ltr">{r.closedShifts}</td>
                      <td className={cn(numCls, r.flagged && "font-bold text-destructive")} dir="ltr">{r.shortageShifts}</td>
                      <td className={cn(numCls, "text-money-negative")} dir="ltr">{fmtAr(r.totalShortage)}</td>
                      <td className={cn(numCls, "text-muted-foreground")} dir="ltr">{fmtAr(r.totalSurplus)}</td>
                      <FlagCell flagged={r.flagged} />
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </SectionCard>

          {/* D5 — السندات المعكوسة */}
          <SectionCard
            title="السندات المعكوسة"
            subtitle="سندات قبض/صرف عُكست بالفترة. المؤشر: عاكسٌ عكس سندَين فأكثر."
            count={aw.kpis.reversedVouchers}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className={thCls}>السند</th>
                  <th className={thCls}>الاتجاه</th>
                  <th className={thCls}>المبلغ</th>
                  <th className={thCls}>منشئه</th>
                  <th className={thCls}>عاكسه</th>
                  <th className={thCls}>وقت العكس</th>
                  <th className={thCls}></th>
                </tr>
              </thead>
              <tbody>
                {aw.reversedVouchers.rows.length === 0 ? (
                  <TableEmptyRow colSpan={7} message="لا سندات معكوسة في الفترة." />
                ) : (
                  aw.reversedVouchers.rows.map((r, i) => (
                    <tr key={i} className={cn("border-b last:border-0", r.flagged && "bg-destructive/5")}>
                      <td className={cn(tdCls, "font-mono text-xs")} dir="ltr">{r.voucherNumber}</td>
                      <td className={tdCls}>{r.direction === "OUT" ? "صرف" : "قبض"}</td>
                      <td className={numCls} dir="ltr">{fmtAr(r.amount)}</td>
                      <td className={tdCls}>{r.createdByName}</td>
                      <td className={tdCls}>{r.reversedByName}</td>
                      <td className={numCls} dir="ltr">{r.reversedAt}</td>
                      <FlagCell flagged={r.flagged} />
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </SectionCard>
        </div>
      )}
    </ReportShell>
  );
}
