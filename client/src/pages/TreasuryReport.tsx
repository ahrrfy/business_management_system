// تقرير الخزينة — مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي) + ملخّص فروقات الورديات.
// عرض + تصدير Excel + طباعة A4 (ReportShell + PeriodFilter + printReportDoc).
// ⚠️ أساس نقدي: من المقبوضات/المدفوعات المكتملة (receipts COMPLETED) لا الاستحقاق.
import { useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { PeriodFilter, DEFAULT_PERIOD, ymd, type PeriodValue } from "@/components/reports/PeriodFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtAr, D } from "@/lib/money";
import { exportSheets, type SheetSpec } from "@/lib/export";
import { printTreasuryReportA4 } from "@/lib/printing/printTreasuryReportA4";
import { CopyButton, CopyInline } from "@/components/CopyButton";
import { fmtDateTime } from "@/lib/date";
import { ChevronLeft, ChevronRight } from "lucide-react";

type TS = RouterOutputs["reports"]["treasurySummary"];

const NOTE =
  "أساس نقدي مباشر: من المقبوضات/المدفوعات المكتملة (لا أساس الاستحقاق). الفروقات حسب الورديات المفتوحة في الفترة (تاريخ الفتح). النقد حسب الفرع المحدّد.";
const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const SHIFT_TYPE_LABEL: Record<string, string> = {
  RETAIL: "تجزئة",
  RECEPTION: "استقبال",
  PRINT_SERVICES: "خدمات طباعة",
};
const RECONCILIATION_LABEL: Record<string, string> = {
  MATCHED: "مطابقة",
  EXPLAINED: "فرق مفسّر",
  MANAGER_APPROVED: "معتمدة إدارياً",
};

export default function TreasuryReport() {
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [branchId, setBranchId] = useState<number | "">("");
  const branches = trpc.branches.list.useQuery();
  const q = trpc.reports.treasurySummary.useQuery({
    from: period.from,
    to: period.to,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const ts: TS | undefined = q.data;

  const kpis: KpiItem[] = ts
    ? [
        { label: "المقبوضات", value: fmtAr(ts.totalIn), tone: "positive" },
        { label: "المدفوعات", value: fmtAr(ts.totalOut), tone: "negative" },
        { label: "صافي الصندوق", value: fmtAr(ts.net), tone: D(ts.net).gte(0) ? "positive" : "negative" },
        {
          label: "فروقات الورديات",
          value: fmtAr(ts.shifts.totalVariance),
          tone: D(ts.shifts.totalVariance).gte(0) ? "info" : "negative",
          hint: `${ts.shifts.count} وردية`,
        },
      ]
    : [];

  // صفوف جدول طرق الدفع لإعادة الاستعمال (عرض/تصدير/طباعة).
  const rows = useMemo(
    () => (ts ? ts.methods.map((m) => ({ ...m, settlementLabel: m.settlement === "DRAWER" ? "درج الكاشير" : "إلكتروني / خارج الدرج" })) : []),
    [ts],
  );

  const branchLabel = branchId ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)) : "الكل";

  // نص مُلخَّص قابل للنسخ (للترويسة).
  const summaryText = useMemo(() => {
    if (!ts) return "";
    const lines = [
      "تقرير الخزينة",
      `الفترة: ${period.from} — ${period.to}`,
      `الفرع: ${branchLabel}`,
      "",
      `المقبوضات: ${fmtAr(ts.totalIn)}`,
      `المدفوعات: ${fmtAr(ts.totalOut)}`,
      `صافي الصندوق: ${fmtAr(ts.net)}`,
      "",
      `عدد الورديات: ${ts.shifts.count}`,
      `النقد المعدود: ${fmtAr(ts.shifts.totalCounted)}`,
      `إجمالي الفروقات: ${fmtAr(ts.shifts.totalVariance)}`,
    ];
    return lines.join("\n");
  }, [ts, period.from, period.to, branchLabel]);

  function onExport() {
    if (!ts) return;
    exportSheets(`الخزينة-${period.from}-${period.to}`, [
      {
        sheetName: "طرق الدفع",
        title: "تقرير الخزينة — طرق الدفع",
        meta: [{ label: "الفترة", value: `${period.from} — ${period.to}` }, { label: "الفرع", value: branchLabel }],
        rows,
        columns: [
          { key: "label", header: "طريقة الدفع" },
          { key: "settlementLabel", header: "مكان التسوية" },
          { key: "in", header: "مقبوضات", money: true, map: (r) => Number(r.in) },
          { key: "out", header: "مدفوعات", money: true, map: (r) => Number(r.out) },
          { key: "net", header: "الصافي", money: true, map: (r) => Number(r.net) },
        ],
        totalsRow: { label: "الإجمالي", in: Number(ts.totalIn), out: Number(ts.totalOut), net: Number(ts.net) },
      } as SheetSpec<any>,
      {
        sheetName: "تسوية الورديات",
        title: "تقرير الخزينة — تسوية الورديات النقدية",
        meta: [{ label: "الفترة", value: `${period.from} — ${period.to}` }, { label: "الفرع", value: branchLabel }],
        rows: ts.shifts.rows,
        columns: [
          { key: "id", header: "رقم الوردية" },
          { key: "branchName", header: "الفرع" },
          { key: "cashierName", header: "الكاشير" },
          { key: "shiftType", header: "النوع", map: (r) => SHIFT_TYPE_LABEL[r.shiftType] ?? r.shiftType },
          { key: "status", header: "الحالة", map: (r) => r.status === "CLOSED" ? "مغلقة" : "مفتوحة" },
          { key: "openedAt", header: "فُتحت", map: (r) => fmtDateTime(r.openedAt) },
          { key: "closedAt", header: "أُغلقت", map: (r) => r.closedAt ? fmtDateTime(r.closedAt) : "—" },
          { key: "openingBalance", header: "افتتاحي", money: true, map: (r) => Number(r.openingBalance) },
          { key: "expectedCash", header: "نقد متوقّع", money: true, map: (r) => r.expectedCash == null ? "" : Number(r.expectedCash) },
          { key: "countedCash", header: "نقد معدود", money: true, map: (r) => r.countedCash == null ? "" : Number(r.countedCash) },
          { key: "variance", header: "الفرق", money: true, map: (r) => r.variance == null ? "" : Number(r.variance) },
          { key: "reconciliationStatus", header: "التسوية", map: (r) => r.reconciliationStatus ? (RECONCILIATION_LABEL[r.reconciliationStatus] ?? r.reconciliationStatus) : "بانتظار الإغلاق" },
        ],
        totalsRow: { id: "الإجمالي", countedCash: Number(ts.shifts.totalCounted), variance: Number(ts.shifts.totalVariance) },
      } as SheetSpec<any>,
    ]);
  }

  // طباعة A4 — وثيقة توقيع واعتماد (أمين الصندوق/المحاسب/المدير)، لا جدول تقرير مجرّد
  // (استُبدل printReportDoc العام بقالبٍ مخصّص يحمل خانات التوقيع — التفصيل الكامل في تصدير Excel).
  function onPrint() {
    if (!ts) return;
    const opened = printTreasuryReportA4({
      from: period.from,
      to: period.to,
      branchLabel,
      methods: ts.methods.map((m) => ({ label: m.label, in: m.in, out: m.out, net: m.net, settlement: m.settlement })),
      totalIn: ts.totalIn,
      totalOut: ts.totalOut,
      net: ts.net,
      shiftsCount: ts.shifts.count,
      totalCounted: ts.shifts.totalCounted,
      totalVariance: ts.shifts.totalVariance,
    });
    if (!opened) alert("حجب المتصفح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
  }

  // تنقّل سريع بين الفترات المتجاورة (يوم سابق/تالي) — يزيح كامل نافذة [from,to] بنفس طولها،
  // مفيدٌ خاصةً حين الفترة يوم واحد (إغلاق يومي متتابع) لكنه يعمل لأي طول فترة.
  function shiftPeriod(deltaDays: number) {
    const f = new Date(`${period.from}T00:00:00`);
    const t = new Date(`${period.to}T00:00:00`);
    if (isNaN(f.getTime()) || isNaN(t.getTime())) return;
    f.setDate(f.getDate() + deltaDays);
    t.setDate(t.getDate() + deltaDays);
    setPeriod({ from: ymd(f), to: ymd(t), preset: "custom" });
  }
  /** أعمدة ملخّص الخزينة + ذيل الإجماليات (مقبوضات/مدفوعات/صافي). */
  const treasuryColumns = useMemo<ColumnDef<(typeof rows)[number], unknown>[]>(() => [
    {
      id: "label", header: "طريقة الدفع",
      accessorFn: (r) => r.label,
      cell: ({ row }) => <span className="font-medium">{row.original.label}</span>,
      footer: () => (ts ? "الإجمالي" : null),
      meta: { kind: "text" },
    },
    {
      id: "settlement", header: "مكان التسوية",
      accessorFn: (r) => r.settlementLabel,
      cell: ({ row }) => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${row.original.settlement === "DRAWER" ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" : "bg-[var(--sem-info-bg)] text-[var(--sem-info)]"}`}>
          {row.original.settlementLabel}
        </span>
      ),
      footer: () => (ts ? <span className="text-muted-foreground">—</span> : null),
      meta: { kind: "status" },
    },
    {
      id: "in", header: "مقبوضات",
      accessorFn: (r) => Number(r.in),
      cell: ({ row }) => <span className="text-money-positive"><CopyInline value={String(row.original.in)} display={fmtAr(row.original.in)} mono={false} /></span>,
      footer: () => (ts ? <CopyInline value={String(ts.totalIn)} display={fmtAr(ts.totalIn)} mono={false} /> : null),
      meta: { kind: "money" },
    },
    {
      id: "out", header: "مدفوعات",
      accessorFn: (r) => Number(r.out),
      cell: ({ row }) => <span className="text-money-negative"><CopyInline value={String(row.original.out)} display={fmtAr(row.original.out)} mono={false} /></span>,
      footer: () => (ts ? <CopyInline value={String(ts.totalOut)} display={fmtAr(ts.totalOut)} mono={false} /> : null),
      meta: { kind: "money" },
    },
    {
      id: "net", header: "الصافي",
      accessorFn: (r) => Number(r.net),
      cell: ({ row }) => (
        <span className={D(row.original.net).lt(0) ? "font-semibold text-money-negative" : "font-semibold text-money-positive"}>
          <CopyInline value={String(row.original.net)} display={fmtAr(row.original.net)} mono={false} />
        </span>
      ),
      footer: () => (ts ? <CopyInline value={String(ts.net)} display={fmtAr(ts.net)} mono={false} /> : null),
      meta: { kind: "money" },
    },
  ], [ts]);

  /** أعمدة تفاصيل تسوية الورديات — ثابتةٌ بلا اعتمادٍ على الحالة (الصفوف تأتي من `ts`). */
  const shiftColumns = useMemo<ColumnDef<TS["shifts"]["rows"][number], unknown>[]>(() => [
    { id: "id", header: "#", accessorFn: (s) => s.id, meta: { kind: "number", width: "id" }, cell: ({ row }) => row.original.id },
    { id: "branchName", header: "الفرع", accessorFn: (s) => s.branchName ?? "—", cell: ({ row }) => row.original.branchName ?? "—" },
    { id: "cashierName", header: "الكاشير", accessorFn: (s) => s.cashierName ?? "—", meta: { kind: "actor" }, cell: ({ row }) => row.original.cashierName ?? "—" },
    {
      id: "shiftType",
      header: "النوع",
      accessorFn: (s) => SHIFT_TYPE_LABEL[s.shiftType] ?? s.shiftType,
      cell: ({ row }) => <span className="text-xs">{SHIFT_TYPE_LABEL[row.original.shiftType] ?? row.original.shiftType}</span>,
    },
    {
      id: "period",
      header: "الفترة",
      accessorFn: (s) => `${fmtDateTime(s.openedAt)} — ${s.closedAt ? fmtDateTime(s.closedAt) : "مفتوحة"}`,
      meta: { kind: "datetime" },
      cell: ({ row }) => (
        <span className="text-xs">
          {fmtDateTime(row.original.openedAt)}
          <br />
          {row.original.closedAt ? fmtDateTime(row.original.closedAt) : "مفتوحة"}
        </span>
      ),
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (s) => (s.status === "CLOSED" ? "مغلقة" : "مفتوحة"),
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${row.original.status === "CLOSED" ? "bg-muted text-muted-foreground" : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"}`}>
          {row.original.status === "CLOSED" ? "مغلقة" : "مفتوحة"}
        </span>
      ),
    },
    {
      id: "expectedCash",
      header: "المتوقّع النقدي",
      accessorFn: (s) => (s.expectedCash == null ? "—" : fmtAr(s.expectedCash)),
      meta: { kind: "money" },
      cell: ({ row }) =>
        row.original.expectedCash == null ? "—" : <CopyInline value={row.original.expectedCash} display={fmtAr(row.original.expectedCash)} mono={false} />,
    },
    {
      id: "countedCash",
      header: "المعدود",
      accessorFn: (s) => (s.countedCash == null ? "—" : fmtAr(s.countedCash)),
      meta: { kind: "money" },
      cell: ({ row }) =>
        row.original.countedCash == null ? "—" : <CopyInline value={row.original.countedCash} display={fmtAr(row.original.countedCash)} mono={false} />,
    },
    {
      id: "variance",
      header: "الفرق",
      accessorFn: (s) => (s.variance == null ? "—" : fmtAr(s.variance)),
      meta: { kind: "money" },
      cell: ({ row }) =>
        row.original.variance == null ? (
          "—"
        ) : (
          <span className={`font-semibold ${D(row.original.variance).lt(0) ? "text-money-negative" : "text-money-positive"}`}>
            <CopyInline value={row.original.variance} display={fmtAr(row.original.variance)} mono={false} />
          </span>
        ),
    },
    {
      id: "reconciliationStatus",
      header: "التسوية",
      accessorFn: (s) => (s.reconciliationStatus ? (RECONCILIATION_LABEL[s.reconciliationStatus] ?? s.reconciliationStatus) : "بانتظار الإغلاق"),
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span className="text-xs">
          {row.original.reconciliationStatus
            ? (RECONCILIATION_LABEL[row.original.reconciliationStatus] ?? row.original.reconciliationStatus)
            : "بانتظار الإغلاق"}
        </span>
      ),
    },
  ], []);

  return (
    <ReportShell
      title="تقرير الخزينة"
      description="مقبوضات/مدفوعات حسب طريقة الدفع (أساس نقدي) + فروقات الورديات."
      note={NOTE}
      kpis={kpis}
      actions={
        ts ? (
          <CopyButton value={summaryText} title="نسخ المُلخَّص" size="sm" variant="outline" />
        ) : null
      }
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!ts}
      printDisabled={!ts}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <PeriodFilter value={period} onChange={setPeriod} />
          {/* تنقّل سريع ليوم سابق/تالٍ — يزيح الفترة كاملةً محافظاً على طولها. */}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" title="الفترة السابقة" aria-label="الفترة السابقة" onClick={() => shiftPeriod(-1)}>
              <ChevronRight aria-hidden className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" title="الفترة التالية" aria-label="الفترة التالية" onClick={() => shiftPeriod(1)}>
              <ChevronLeft aria-hidden className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect className="h-9" value={String(branchId)} onValueChange={(value) => setBranchId(value ? Number(value) : "")}>
              <option value="">الكل</option>
              {branches.data?.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </AppSelect>
          </div>
        </div>
      }
    >
      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={treasuryColumns}
            data={rows}
            loading={q.isLoading}
            searchable={false}
            errorState={{ isError: q.isError, message: "تعذّر تحميل التقرير.", onRetry: () => void q.refetch() }}
            emptyText="لا حركات في الفترة."
          />
        </CardContent>
      </Card>

      {/* ملخّص فروقات الورديات */}
      {ts && (
        <Card>
          <CardContent className="pt-4 pb-3">
            <h2 className="mb-3 text-sm font-bold">ملخّص الورديات في الفترة</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground">عدد الورديات</p>
                <p className="text-lg font-bold tabular-nums" dir="ltr">
                  <CopyInline value={String(ts.shifts.count)} display={String(ts.shifts.count)} mono={false} />
                </p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground">النقد المعدود</p>
                <p className="text-lg font-bold tabular-nums" dir="ltr">
                  <CopyInline
                    value={String(ts.shifts.totalCounted)}
                    display={fmtAr(ts.shifts.totalCounted)}
                    mono={false}
                  />
                </p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-xs text-muted-foreground">إجمالي الفروقات</p>
                <p
                  className={`text-lg font-bold tabular-nums ${D(ts.shifts.totalVariance).lt(0) ? "text-money-negative" : "text-money-positive"}`}
                  dir="ltr"
                >
                  <CopyInline
                    value={String(ts.shifts.totalVariance)}
                    display={fmtAr(ts.shifts.totalVariance)}
                    mono={false}
                  />
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {ts && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-bold">تفاصيل تسوية الورديات النقدية</h2>
              <p className="mt-1 text-xs text-muted-foreground">المتوقّع والمعدود هنا للنقد الموجود في الدرج فقط؛ لا تدخل البطاقة أو التحويل في مبلغ إغلاق الكاشير.</p>
            </div>
            {/* مُضمَّن: البطاقة تحمل العنوان والشرح؛ و`pageSize=Infinity` إلزاميّ مع `embedded`
                لأنّ شريط الحالة (وفيه أزرار الترقيم) مكتومٌ — بلا ذلك تُحبَس الصفوف بعد الخمسين
                بلا وسيلة وصول. الارتفاع المقيّد والترويسة اللاصقة كما كانا. */}
            <DataTable<TS["shifts"]["rows"][number]>
              embedded
              searchable={false}
              pageSize={Infinity}
              maxHeightClass="max-h-[calc(100dvh-19rem)]"
              data={ts.shifts.rows}
              columns={shiftColumns}
              emptyText="لا ورديات فُتحت في الفترة."
            />
            {ts.shifts.count > ts.shifts.shownCount && <p className="border-t px-4 py-2 text-xs text-muted-foreground">تُعرض أحدث {ts.shifts.shownCount} وردية من أصل {ts.shifts.count}. صدّر Excel للحصول على الصفوف المعروضة.</p>}
          </CardContent>
        </Card>
      )}
    </ReportShell>
  );
}
