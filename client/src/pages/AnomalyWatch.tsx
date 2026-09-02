// رقيب الشذوذ — ٧ كواشف حتمية لمنع تسرّب الأموال (بلا أي ذكاء اصطناعي):
// بيع دون الكلفة (لقطة الكلفة التاريخية) · طفرة خصومات لكل كاشير · تركّز المرتجعات ·
// عجوزات الورديات · عكس السندات · سلامة تسلسل الترقيم (كاشف عبث بقاعدة البيانات) ·
// تركّز سحوبات بضاعة الأمانة (ضابط تعويضيّ لـSOD السحب أحاديّ الفاعل).
// الجداول تعرض الجميع والأعلام ترتّب لا تحجب. تصدير Excel متعدد الأوراق (ورقة لكل كاشف).
import { useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { AlertTriangle } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, presetRange, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtAr } from "@/lib/money";
import { exportSheets, type SheetSpec } from "@/lib/export";
import { selectCls } from "@/lib/ui/formStyles";

type AW = RouterOutputs["reports"]["anomalyWatch"];

/* ————— بناة أعمدة الكواشف —————
 * الكواشف الستّة عشر متطابقةُ الشكل: صفٌّ يُلوَّن حين يُعلَّم، وأعمدةٌ رقمية تُبرَز عند
 * التعليم، وعمودُ علمٍ أخيرٌ بلا رأس. البناة أدناه تمنع تكرار ذلك ستّ عشرة مرّة —
 * وتمنع الانجراف الذي بدأت منه هذه الحملة (كل جدولٍ يقرّر تنسيقه بنفسه).
 */

type Flaggable = { flagged?: boolean };

/** عمود العلم — بلا رأس، في نهاية كل كاشف. */
function flagCol<T extends Flaggable>(): ColumnDef<T, unknown> {
  return {
    id: "flag",
    header: "",
    meta: { align: "end", width: "status" },
    cell: ({ row }) =>
      row.original.flagged ? (
        <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
          <AlertTriangle aria-hidden className="size-3" />
          مؤشر
        </span>
      ) : null,
  };
}

/**
 * تلوين الصفّ المُعلَّم. النبرة تتبع طبيعة الكاشف ولا تُوحَّد:
 * `danger` لخسارةٍ أو عبثٍ مؤكَّد، و`warn` لنمطٍ يستوجب متابعةً لا اتّهاماً.
 */
const flagRow =
  (tone: "danger" | "warn" = "danger") =>
  (r: Flaggable) =>
    r.flagged ? (tone === "danger" ? "bg-destructive/5" : "bg-[var(--sem-warn-bg)]") : undefined;

/** يُبرِز قيمةً رقمية حين يكون صفُّها معلَّماً. */
function strong(flagged: boolean | undefined, node: React.ReactNode) {
  return flagged ? <span className="font-bold text-destructive">{node}</span> : <>{node}</>;
}

/*
 * ⚠️ كلُّ بانٍ يضع `accessorFn` بجانب `cell` (Codex P2 على PR #939): «نسخ القيمة» في قائمة
 * سياق الجدول يقرأ `row.getValue(id)`، والعمودُ الذي يعرّف `id` و`cell` وحدَهما يُرجع
 * `undefined` ⇒ تُنسَخ الرؤوسُ بقيمٍ فارغة والأمرُ يختفي رغم وجود محتوى ظاهر.
 * تمريرُ نفس الجالب آمنٌ: `cellPrimitive` يُسقط عناصر React فيبقى النصُّ والرقم وحدهما.
 */

/** عمود نصّي بسيط. */
function txtCol<T>(id: string, header: string, get: (r: T) => React.ReactNode): ColumnDef<T, unknown> {
  return { id, header, accessorFn: get, cell: ({ row }) => get(row.original) };
}

/** عمود رقميّ (عدّ أو نسبة) — `kind: "number"` يتكفّل بالمحاذاة وعزل الاتّجاه. */
function numCol<T>(id: string, header: string, get: (r: T) => React.ReactNode): ColumnDef<T, unknown> {
  return { id, header, accessorFn: get, meta: { kind: "number" }, cell: ({ row }) => get(row.original) };
}

/** عمود مبلغ. */
function moneyCol<T>(id: string, header: string, get: (r: T) => React.ReactNode): ColumnDef<T, unknown> {
  return { id, header, accessorFn: get, meta: { kind: "money" }, cell: ({ row }) => get(row.original) };
}

/** الخصائص المشتركة لكل جداول الكواشف: مُضمَّنة في بطاقةٍ تحمل العنوان والعدّ. */
const DETECTOR_TABLE = { embedded: true, searchable: false, bounded: false, pageSize: Infinity } as const;

const NOTE =
  "كواشف حتمية على بيانات النظام كما هي: «دون الكلفة» يقارن بلقطة الكلفة وقت البيع لا الكلفة الحالية؛ " +
  "«معالجو الإرجاع» من سجلّ التدقيق (قد ينقص عند تعذّر تسجيله)؛ أي فجوة تسلسل تعني حذف صفوف من قاعدة البيانات مباشرةً (مستحيلة من التطبيق).";


/** فترة افتراضية: آخر ٧ أيام (تقرير أسبوعي بطبيعته). */
const WEEK_PERIOD: PeriodValue = { ...presetRange("week"), preset: "week" };

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
        { label: "مُنشئو سحب أمانة مُعلَّمون", value: String(aw.kpis.flaggedConsignWithdrawers), tone: aw.kpis.flaggedConsignWithdrawers > 0 ? "warning" : "positive" },
        { label: "مُلغو طلبات مموّلة مُعلَّمون", value: String(aw.kpis.flaggedCancelledFundedDrafters), tone: aw.kpis.flaggedCancelledFundedDrafters > 0 ? "warning" : "positive" },
        { label: "محصّلو رصيد زين مُعلَّمون", value: String(aw.kpis.flaggedTelecomCollectors), tone: aw.kpis.flaggedTelecomCollectors > 0 ? "warning" : "positive" },
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
      {
        sheetName: "سحوبات الأمانة",
        title: "تركّز سحوبات بضاعة الأمانة حسب المُنشئ",
        meta,
        columns: [
          { key: "userName", header: "المُنشئ" },
          { key: "noteCount", header: "سندات السحب/الاستبدال" },
          { key: "totalQty", header: "الوحدات المسحوبة" },
          { key: "totalValue", header: "قيمة الحصص", money: true, map: (r: any) => Number(r.totalValue) },
          { key: "flagged", header: "مؤشر", map: (r: any) => (r.flagged ? "نعم" : "") },
        ],
        rows: aw.consignWithdrawals.rows as any[],
      },
    ];
    exportSheets(`رقيب-الشذوذ-${aw.from}-${aw.to}`, sheets);
  }

  return (
    <ReportShell
      title="رقيب الشذوذ"
      description="كواشف حتمية لمنع تسرّب الأموال: بيع دون الكلفة، خصومات، مرتجعات، عجوزات، عكوس، سلامة الترقيم، وسحوبات الأمانة."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      exportDisabled={!aw}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(next) => setBranchId(next ? Number(next) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
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
              <DataTable<AW["sequenceGaps"]["rows"][number]>
                {...DETECTOR_TABLE}
                data={aw.sequenceGaps.rows}
                /* كل صفٍّ هنا حرجٌ بذاته — لا علمَ يميّز، فالوجودُ هو الإشارة. */
                getRowClassName={() => "bg-destructive/5"}
                columns={[
                  txtCol("branch", "الفرع", (r) => r.branchName),
                  numCol("day", "اليوم", (r) => r.day),
                  numCol("actual", "الموجود", (r) => r.actualCount),
                  numCol("maxSeq", "أعلى تسلسل", (r) => r.maxSeq),
                  numCol("missing", "المفقود", (r) => <span className="font-bold text-destructive">{r.missing}</span>),
                ]}
              />
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
                <DataTable<AW["belowCost"]["cashiers"][number]>
                  {...DETECTOR_TABLE}
                  data={aw.belowCost.cashiers}
                  getRowClassName={() => "bg-destructive/5"}
                  columns={[
                    txtCol("user", "الكاشير", (r) => r.userName),
                    numCol("lines", "الأسطر", (r) => r.lineCount),
                    moneyCol("loss", "الخسارة", (r) => <span className="text-money-negative font-medium">{fmtAr(r.lossValue)}</span>),
                  ]}
                />
                <p className="border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">أسوأ الأسطر (أعلى ١٠ خسارةً)</p>
                <DataTable<AW["belowCost"]["worstLines"][number]>
                  {...DETECTOR_TABLE}
                  data={aw.belowCost.worstLines}
                  columns={[
                    { id: "invoice", header: "الفاتورة", meta: { kind: "code" }, cell: ({ row }) => row.original.invoiceNumber },
                    numCol("date", "التاريخ", (r) => r.invoiceDate),
                    txtCol("user", "الكاشير", (r) => r.userName),
                    txtCol("product", "المنتج", (r) => r.productName),
                    numCol("qty", "الكمية", (r) => fmtAr(r.quantity)),
                    moneyCol("net", "صافي السطر", (r) => fmtAr(r.lineTotal)),
                    moneyCol("cost", "كلفته", (r) => fmtAr(r.lineCost)),
                    moneyCol("loss", "الخسارة", (r) => <span className="text-money-negative font-medium">{fmtAr(r.lossValue)}</span>),
                  ]}
                />
              </>
            )}
          </SectionCard>

          {/* D2 — الخصومات */}
          <SectionCard
            title="الخصومات اليدوية حسب الكاشير"
            subtitle={`المؤشر: نسبة ≥ ضعفَي متوسط النطاق (${aw.discounts.scopeAvgRatePct}%) و≥ ٥٪. خصم العروض آليّ ويُعرض للسياق فقط.`}
            count={aw.kpis.flaggedDiscountCashiers}
          >
            <DataTable<AW["discounts"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.discounts.rows}
              getRowClassName={flagRow()}
              emptyText="لا مبيعات في الفترة."
              columns={[
                txtCol("user", "الكاشير", (r) => r.userName),
                numCol("invoices", "الفواتير", (r) => r.invoiceCount),
                moneyCol("gross", "البيع قبل الخصم", (r) => fmtAr(r.grossTotal)),
                moneyCol("manual", "الخصم اليدوي", (r) => fmtAr(r.manualDiscount)),
                numCol("rate", "النسبة", (r) => strong(r.flagged, `${r.discountRatePct}%`)),
                moneyCol("promo", "خصم العروض", (r) => <span className="text-muted-foreground">{fmtAr(r.promoDiscount)}</span>),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D3 — المرتجعات */}
          <SectionCard
            title="تركّز المرتجعات"
            subtitle={`نسبة مرتجعات مبيعات كل بائع (متوسط النطاق ${aw.returns.scopeAvgRatePct}%). «معالجو الإرجاع» من سجلّ التدقيق — قد ينقص.`}
            count={aw.kpis.flaggedReturnSellers}
          >
            <DataTable<AW["returns"]["sellers"][number]>
              {...DETECTOR_TABLE}
              data={aw.returns.sellers}
              getRowClassName={flagRow()}
              emptyText="لا مبيعات في الفترة."
              columns={[
                txtCol("user", "البائع", (r) => r.userName),
                numCol("invoices", "الفواتير", (r) => r.invoiceCount),
                moneyCol("sales", "المبيعات", (r) => fmtAr(r.salesTotal)),
                moneyCol("returned", "المرتجع", (r) => fmtAr(r.returnedTotal)),
                numCol("rate", "النسبة", (r) => strong(r.flagged, `${r.returnRatePct}%`)),
                flagCol(),
              ]}
            />
            {aw.returns.processors.length > 0 && (
              <>
                <p className="border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">معالجو الإرجاع (من سجلّ التدقيق)</p>
                <DataTable<AW["returns"]["processors"][number]>
                  {...DETECTOR_TABLE}
                  data={aw.returns.processors}
                  columns={[
                    txtCol("user", "المستخدم", (r) => r.userName),
                    numCol("ops", "عمليات إرجاع", (r) => r.opsCount),
                  ]}
                />
              </>
            )}
          </SectionCard>

          {/* D4 — العجوزات */}
          <SectionCard
            title="عجوزات الورديات"
            subtitle="المؤشر: ورديتا عجزٍ فأكثر بالفترة أو إجمالي عجز ≥ ٢٥٬٠٠٠ د.ع. الفائض يُعرض أيضاً (قد يدل على بيع غير مسجَّل)."
            count={aw.kpis.flaggedShortageCashiers}
          >
            <DataTable<AW["shiftShortages"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.shiftShortages.rows}
              getRowClassName={flagRow()}
              emptyText="لا فروقات صندوق في الفترة."
              columns={[
                txtCol("user", "الكاشير", (r) => r.userName),
                numCol("closed", "ورديات مغلقة", (r) => r.closedShifts),
                numCol("short", "ورديات عجز", (r) => strong(r.flagged, r.shortageShifts)),
                moneyCol("shortTotal", "إجمالي العجز", (r) => <span className="text-money-negative">{fmtAr(r.totalShortage)}</span>),
                moneyCol("surplus", "إجمالي الفائض", (r) => <span className="text-muted-foreground">{fmtAr(r.totalSurplus)}</span>),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D5 — السندات المعكوسة */}
          <SectionCard
            title="السندات المعكوسة"
            subtitle="سندات قبض/صرف عُكست بالفترة. المؤشر: عاكسٌ عكس سندَين فأكثر."
            count={aw.kpis.reversedVouchers}
          >
            <DataTable<AW["reversedVouchers"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.reversedVouchers.rows}
              getRowClassName={flagRow()}
              emptyText="لا سندات معكوسة في الفترة."
              columns={[
                { id: "voucher", header: "السند", meta: { kind: "code" }, cell: ({ row }) => row.original.voucherNumber },
                txtCol("direction", "الاتجاه", (r) => (r.direction === "OUT" ? "صرف" : "قبض")),
                moneyCol("amount", "المبلغ", (r) => fmtAr(r.amount)),
                txtCol("createdBy", "منشئه", (r) => r.createdByName),
                txtCol("reversedBy", "عاكسه", (r) => r.reversedByName),
                numCol("reversedAt", "وقت العكس", (r) => r.reversedAt),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D7 — تركّز سحوبات بضاعة الأمانة (ضابط تعويضيّ لـSOD السحب أحاديّ الفاعل) */}
          <SectionCard
            title="تركّز سحوبات بضاعة الأمانة"
            subtitle="سندات سحب/استبدال بضاعة أمانة تُعيدها لمودِعها بلا فاعلٍ ثانٍ. المؤشر: مُنشئٌ أنشأ ٣ سندات فأكثر بالفترة."
            count={aw.kpis.flaggedConsignWithdrawers}
          >
            <DataTable<AW["consignWithdrawals"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.consignWithdrawals.rows}
              getRowClassName={flagRow("warn")}
              emptyText="لا سحوبات بضاعة أمانة في الفترة."
              columns={[
                txtCol("user", "المُنشئ", (r) => r.userName),
                numCol("notes", "سندات السحب/الاستبدال", (r) => strong(r.flagged, r.noteCount)),
                numCol("qty", "الوحدات المسحوبة", (r) => fmtAr(r.totalQty)),
                moneyCol("value", "قيمة الحصص", (r) => <span className="text-muted-foreground">{fmtAr(r.totalValue)}</span>),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D8 (ش٤) — مسوّدات استقبالٍ مموّلة أُلغيت بلا تثبيت (نمط «اقبض ثم رُدّ ثم ألغِ») */}
          <SectionCard
            title="طلبات محفوظة مموّلة أُلغيت بلا تثبيت"
            subtitle="طلبٌ قُبض عليه عربون ثم رُدَّ وأُلغي بلا فاتورة — كل مستندٍ سليمٌ فردياً، والتكرار هو الإشارة. المؤشر: مُنشئٌ له طلبان فأكثر بالفترة."
            count={aw.kpis.flaggedCancelledFundedDrafters}
          >
            <DataTable<AW["cancelledFundedDrafts"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.cancelledFundedDrafts.rows}
              getRowClassName={flagRow("warn")}
              emptyText="لا طلبات مموّلة أُلغيت في الفترة."
              columns={[
                txtCol("user", "المُنشئ", (r) => r.userName),
                numCol("drafts", "الطلبات الملغاة المموّلة", (r) => strong(r.flagged, r.draftCount)),
                moneyCol("collected", "المقبوض عليها", (r) => fmtAr(r.collectedTotal)),
                moneyCol("refunded", "المردود منها", (r) => <span className="text-muted-foreground">{fmtAr(r.refundedTotal)}</span>),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D9 (ش٥ — §٩.٤) — نسبة رصيد زين من تحصيل الموظف: الطريقة الوحيدة بلا مُثبِتٍ خارجيّ */}
          <SectionCard
            title="تركّز قبض رصيد زين"
            subtitle="رصيد الاتصال بلا قسيمة جهازٍ ولا سجلّ مصرف — تركّزه لدى موظفٍ إشارةُ «نقدٌ قُبض وسُجِّل رصيداً». المؤشر: ≥٣٠٪ من وارده وبمبلغ ≥١٠٠ ألف بالفترة."
            count={aw.kpis.flaggedTelecomCollectors}
          >
            <DataTable<AW["telecomShares"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.telecomShares.rows}
              getRowClassName={flagRow("warn")}
              emptyText="لا قبض رصيد زين في الفترة."
              columns={[
                txtCol("user", "الموظف", (r) => r.userName),
                moneyCol("telecom", "رصيد زين", (r) => strong(r.flagged, fmtAr(r.telecomIn))),
                moneyCol("total", "إجمالي وارده", (r) => fmtAr(r.totalIn)),
                numCol("share", "النسبة", (r) => strong(r.flagged, `${r.sharePct}%`)),
                numCol("receipts", "عدد القبضات", (r) => r.receiptCount),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D10 (ش٦) — مسوّدات مموّلة معلّقة > ٢٤ ساعة: مال زبونٍ محتجزٌ بلا مستند نهائيّ */}
          <SectionCard
            title="طلبات محفوظة مموّلة معلّقة أكثر من يوم"
            subtitle="مالُ زبونٍ مقبوضٌ عربوناً وطلبُه ما زال معلّقاً بلا فاتورةٍ ولا إلغاء — كل صفٍّ إنذارٌ يُتابَع (تثبيتٌ أو ردّ). لقطة حاضرة لا تتقيّد بالفترة."
            count={aw.kpis.fundedStaleDrafts}
          >
            <DataTable<AW["fundedStaleDrafts"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.fundedStaleDrafts.rows}
              /* كل صفٍّ إنذارٌ بذاته — لا علمَ يميّز. */
              getRowClassName={() => "bg-[var(--sem-warn-bg)]"}
              emptyText="لا طلبات مموّلة معلّقة فوق يوم."
              columns={[
                txtCol("draft", "الطلب", (r) => r.draftNumber),
                txtCol("user", "المُنشئ", (r) => r.userName),
                moneyCol("held", "المحتجز", (r) => <span className="font-bold text-destructive">{fmtAr(r.heldNet)}</span>),
                numCol("age", "عمره (ساعات)", (r) => r.ageHours),
              ]}
            />
          </SectionCard>

          {/* D11 (ش٦) — تركّز التسديدات على فواتير الغير لكل موظف */}
          <SectionCard
            title="تركّز التسديد على فواتير الغير"
            subtitle="القبض على فاتورة أنشأها زميلٌ مشروعٌ بنطاق الفرع — تكرارُه المكثّف لدى موظفٍ إشارةُ التفافٍ على مساءلة الدرج. المؤشر: ≥٥ تسديداتٍ بالفترة."
            count={aw.kpis.flaggedOthersCollectors}
          >
            <DataTable<AW["othersCollections"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.othersCollections.rows}
              getRowClassName={flagRow("warn")}
              emptyText="لا تسديدات على فواتير الغير في الفترة."
              columns={[
                txtCol("user", "القابض", (r) => r.userName),
                numCol("receipts", "تسديداتٌ على فواتير الغير", (r) => strong(r.flagged, r.receiptCount)),
                moneyCol("total", "مجموعها", (r) => fmtAr(r.totalAmount)),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D12 (ش٦) — خفض إجمالي طلبٍ مموّل بعد القبض (من حدث تدقيق syncDraft) */}
          <SectionCard
            title="خفض إجمالي طلبٍ بعد قبض عربونه"
            subtitle="خفضُ الطلب فوق المحتجز مشروعٌ — تكرارُه لدى موظفٍ إشارةُ تلاعبٍ بالأسعار بعد القبض. المؤشر: ≥٣ أحداثٍ بالفترة (من سجلّ التدقيق — best-effort)."
            count={aw.kpis.flaggedFundedReducers}
          >
            <DataTable<AW["fundedReductions"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.fundedReductions.rows}
              getRowClassName={flagRow("warn")}
              emptyText="لا خفض إجمالياتٍ بعد قبضٍ في الفترة."
              columns={[
                txtCol("user", "الفاعل", (r) => r.userName),
                numCol("events", "مرّات الخفض بعد القبض", (r) => strong(r.flagged, r.eventCount)),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D13 (توصيل ١٠/٨) — عهدة مناديب متقادمة (لقطة راهنة لا تتقيد بالفترة) */}
          <SectionCard
            title="عُهد توصيل متقادمة"
            subtitle="نقدٌ بيد مندوب/شركة لم يُورَّد: العلم عند عمر ≥١٤ يوماً لأقدم إرسالية مفتوحة، أو عهدة ≥٢٠٠ ألف. لقطة حالةٍ راهنة — لا تتقيد بفترة التقرير."
            count={aw.kpis.flaggedDeliveryCustody}
          >
            <DataTable<AW["deliveryCustodyAging"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.deliveryCustodyAging.rows}
              getRowClassName={flagRow("warn")}
              emptyText="لا عُهد توصيل قائمة الآن."
              columns={[
                txtCol("party", "الجهة", (r) => r.partyName),
                moneyCol("balance", "العهدة", (r) => strong(r.flagged, fmtAr(r.balance))),
                numCol("open", "إرساليات مفتوحة", (r) => r.openCount),
                numCol("oldest", "أقدم (يوم)", (r) => strong(r.flagged, r.oldestDays ?? "—")),
                flagCol(),
              ]}
            />
          </SectionCard>

          {/* D14 (توصيل ١٠/٨) — توريدات بعجز متكرّرة لنفس الجهة */}
          <SectionCard
            title="توريدات توصيل بعجز متكرّر"
            subtitle="توريدُ أقلَّ من المتوقّع مرةً قد يكون ظرفاً؛ تكرارُه لنفس الجهة (≥٣ بالفترة) نمطُ «سلّم أقل» يستوجب المتابعة."
            count={aw.kpis.flaggedDeliveryShortRemits}
          >
            <DataTable<AW["deliveryShortRemits"]["rows"][number]>
              {...DETECTOR_TABLE}
              data={aw.deliveryShortRemits.rows}
              getRowClassName={flagRow("warn")}
              emptyText="لا توريدات بعجز في الفترة."
              columns={[
                txtCol("party", "الجهة", (r) => r.partyName),
                numCol("remits", "توريدات الفترة", (r) => r.remitCount),
                numCol("short", "منها بعجز", (r) => strong(r.flagged, r.shortCount)),
                moneyCol("shortfall", "مجموع العجز", (r) => <span className="text-money-negative">{fmtAr(r.shortfallTotal)}</span>),
                flagCol(),
              ]}
            />
          </SectionCard>
        </div>
      )}
    </ReportShell>
  );
}
