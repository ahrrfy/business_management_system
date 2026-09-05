// بند 11 (٧/٧): شاشة «الإقفال الشهري» — صورة الشهر المالية الموحّدة بنقرة (تبويب في محور
// الإقفال والرقابة): مبيعات/ربح إجمالي/مشتريات/مصاريف/خزينة/لقطة ذمم/أوامر مُسلَّمة + طباعة A4.
import { useState } from "react";
import { AppSelect } from "@/components/ui/AppSelect";
import { useLocation } from "wouter";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { MonthPicker } from "@/components/form/MonthPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/PageState";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmtAr, D } from "@/lib/money";
import { exportRows, type ExportColumn } from "@/lib/export";
import { notify } from "@/lib/notify";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { toExcelMoney } from "@/lib/payrollAccrual";
import {
  Printer,
  FileSpreadsheet,
  TrendingUp,
  ShoppingCart,
  Wallet,
  ReceiptText,
  Scale,
  Wrench,
  CircleAlert,
  CircleCheck,
  TriangleAlert,
} from "lucide-react";
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** الشهر المدني الحالي في بغداد YYYY-MM — لا شهر UTC الذي يتأخر ثلاث ساعات عند حدّ الشهر. */
export function currentBaghdadMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  if (!year || !month) throw new Error("تعذّر تحديد الشهر المدني في بغداد");
  return `${year}-${month}`;
}

/** ديسمبر في ACTIVE لا يُعتمد كإقفال شهري؛ يستهلك YearEnd الطلب نفسه بعد قيد الترحيل. */
export function monthCloseUsesYearEnd(
  month: string,
  doubleEntryMode: "OFF" | "SHADOW" | "ACTIVE" | null | undefined,
): boolean {
  return month.endsWith("-12") && doubleEntryMode === "ACTIVE";
}

/** Preserve the selected December year and maker-checker request on the handoff. */
export function yearEndCloseHref(month: string, requestId: number): string {
  const year = month.slice(0, 4);
  const params = new URLSearchParams({
    tab: "yearend",
    year,
    requestId: String(requestId),
  });
  return `/closing?${params.toString()}`;
}

/** fail-closed لزر الاعتماد: غياب قرار جاهزية حيّ أو تعذّره يعطّل الفعل. */
export function monthCloseApprovalDisabled(input: {
  busy: boolean;
  readinessLoading: boolean;
  readinessError: boolean;
  readinessBlocked: boolean | undefined;
  routeLoading?: boolean;
  routeError?: boolean;
}): boolean {
  return (
    input.busy ||
    input.readinessLoading ||
    input.readinessError ||
    input.readinessBlocked !== false ||
    !!input.routeLoading ||
    !!input.routeError
  );
}

/** الشهر السابق لشهرٍ بصيغة YYYY-MM. */
function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** نسبة تغيّر مئوية بدقّة decimal — null إن كان الأساس صفراً (لا معنى للنسبة). */
function deltaPct(curr: string, prev: string): string | null {
  const p = D(prev);
  if (p.isZero()) return null;
  return D(curr).sub(p).div(p).times(100).toDecimalPlaces(1).toString();
}

export type ClosePack = RouterOutputs["reports"]["monthlyClosePack"];
/** ذمم مبنيّة من الدفتر حتى نهاية الشهر (reports.financialPosition.asOf). */
type HistoricalAR = { ar: string; ap: string };

export function monthlyAccountingBasisLabel(
  basis: ClosePack["accountingBasis"],
): string {
  return basis === "DOUBLE_ENTRY_ACTIVE"
    ? "الدفتر المزدوج المعتمد"
    : "تقرير تشغيلي مشتق (OFF/SHADOW)";
}

/** صفوف حزمة الشهر المسطّحة — مصدر واحد يُشارَك بين الطباعة والتصدير.
 *  لا تقبل لقطة «الآن»: فشل as-of يوقف الإخراج التاريخي بدلاً من تبديل معناه بصمت. */
function closePackRows(
  d: ClosePack,
  hist: HistoricalAR,
): { section: string; value: string }[] {
  return [
    { section: "عدد فواتير المبيعات", value: String(d.sales.invoiceCount) },
    { section: "المبيعات (صافٍ قبل الضريبة)", value: fmtAr(d.sales.subtotal) },
    { section: "الضريبة", value: fmtAr(d.sales.tax) },
    { section: "إجمالي المبيعات", value: fmtAr(d.sales.total) },
    { section: "المرتجعات", value: fmtAr(d.sales.returnedTotal) },
    {
      section: "صافي المبيعات بعد المرتجعات",
      value: fmtAr(d.sales.netAfterReturns),
    },
    { section: "تكلفة البضاعة المباعة", value: fmtAr(d.profit.cost) },
    { section: "الربح الإجمالي", value: fmtAr(d.profit.profit) },
    {
      section: "المشتريات (عدد الأوامر)",
      value: String(d.purchases.orderCount),
    },
    { section: "قيمة المشتريات", value: fmtAr(d.purchases.total) },
    { section: "المصروفات", value: fmtAr(d.expenses.total) },
    { section: "صافي الربح", value: fmtAr(d.profit.netProfit) },
    { section: "مقبوضات الخزينة", value: fmtAr(d.treasury.totalIn) },
    { section: "مدفوعات الخزينة", value: fmtAr(d.treasury.totalOut) },
    { section: "صافي حركة الخزينة", value: fmtAr(d.treasury.net) },
    { section: "ذمم العملاء (كما في نهاية الشهر)", value: fmtAr(hist.ar) },
    { section: "ذمم الموردين (كما في نهاية الشهر)", value: fmtAr(hist.ap) },
    { section: "أوامر شغل مُسلَّمة", value: String(d.workOrdersDelivered) },
  ];
}

export type MonthlyCloseExportRow = { section: string; value: number };

export const MONTHLY_CLOSE_EXPORT_COLUMNS: ExportColumn<MonthlyCloseExportRow>[] =
  [
    { key: "section", header: "البند" },
    { key: "value", header: "القيمة (IQD / عدد)", money: true },
  ];

/** صفوف Excel بأرقام حقيقية؛ التنسيق البصري يُطبَّق عبر numFmt لا بتحويل الرقم إلى نص. */
export function monthlyCloseExportRows(
  d: ClosePack,
  hist: HistoricalAR,
): MonthlyCloseExportRow[] {
  return [
    { section: "عدد فواتير المبيعات", value: d.sales.invoiceCount },
    {
      section: "المبيعات (صافٍ قبل الضريبة)",
      value: toExcelMoney(d.sales.subtotal),
    },
    { section: "الضريبة", value: toExcelMoney(d.sales.tax) },
    { section: "إجمالي المبيعات", value: toExcelMoney(d.sales.total) },
    { section: "المرتجعات", value: toExcelMoney(d.sales.returnedTotal) },
    {
      section: "صافي المبيعات بعد المرتجعات",
      value: toExcelMoney(d.sales.netAfterReturns),
    },
    { section: "تكلفة البضاعة المباعة", value: toExcelMoney(d.profit.cost) },
    { section: "الربح الإجمالي", value: toExcelMoney(d.profit.profit) },
    { section: "المشتريات (عدد الأوامر)", value: d.purchases.orderCount },
    { section: "قيمة المشتريات", value: toExcelMoney(d.purchases.total) },
    { section: "المصروفات", value: toExcelMoney(d.expenses.total) },
    { section: "صافي الربح", value: toExcelMoney(d.profit.netProfit) },
    { section: "مقبوضات الخزينة", value: toExcelMoney(d.treasury.totalIn) },
    { section: "مدفوعات الخزينة", value: toExcelMoney(d.treasury.totalOut) },
    { section: "صافي حركة الخزينة", value: toExcelMoney(d.treasury.net) },
    {
      section: "ذمم العملاء (كما في نهاية الشهر)",
      value: toExcelMoney(hist.ar),
    },
    {
      section: "ذمم الموردين (كما في نهاية الشهر)",
      value: toExcelMoney(hist.ap),
    },
    { section: "أوامر شغل مُسلَّمة", value: d.workOrdersDelivered },
  ];
}

export function monthlyCloseExportMeta(
  d: ClosePack,
  branchLabel: string,
  readinessLabel: string,
  requestLabel: string,
): Array<{ label: string; value: string }> {
  return [
    { label: "الفترة", value: `${d.period.from} — ${d.period.to}` },
    { label: "الفرع", value: branchLabel },
    { label: "الجاهزية", value: readinessLabel },
    { label: "طلب الإقفال", value: requestLabel },
    { label: "الأساس المحاسبي", value: monthlyAccountingBasisLabel(d.accountingBasis) },
    { label: "الذمم", value: `لقطة دفترية كما في ${d.period.to}` },
  ];
}

/** بنود المقارنة بالشهر السابق — رباعية (مفتاح/تسمية/هذا الشهر/الشهر السابق). */
const COMPARE_METRICS: {
  key: string;
  label: string;
  pick: (d: ClosePack) => string;
}[] = [
  {
    key: "netSales",
    label: "صافي المبيعات",
    pick: (d) => d.sales.netAfterReturns,
  },
  { key: "profit", label: "الربح الإجمالي", pick: (d) => d.profit.profit },
  { key: "netProfit", label: "صافي الربح", pick: (d) => d.profit.netProfit },
  { key: "purchases", label: "المشتريات", pick: (d) => d.purchases.total },
  { key: "expenses", label: "المصروفات", pick: (d) => d.expenses.total },
  {
    key: "treasuryNet",
    label: "صافي حركة الخزينة",
    pick: (d) => d.treasury.net,
  },
];

type CompareMetric = (typeof COMPARE_METRICS)[number];

/**
 * أعمدة جدول المقارنة — دالّةٌ لا ثابت: تُغلِق على لقطتَي الشهرين وعلى تسميتَي العمودين
 * (اسم الشهر هو ترويسة العمود). تُستدعى في الفرع الذي ثبت فيه توفّر لقطة الشهر السابق.
 */
function compareColumns(d: ClosePack, dPrev: ClosePack, month: string, prevMonth: string): ColumnDef<CompareMetric, unknown>[] {
  const deltaText = (m: CompareMetric) => {
    const pct = deltaPct(m.pick(d), m.pick(dPrev));
    if (pct == null) return "—";
    return `${Number(pct) > 0 ? "+" : ""}${pct}%`;
  };
  return [
    { id: "label", header: "البند", accessorFn: (m) => m.label, cell: ({ row }) => row.original.label },
    { id: "curr", header: month, accessorFn: (m) => fmtAr(m.pick(d)), meta: { kind: "money" }, cell: ({ row }) => fmtAr(row.original.pick(d)) },
    {
      id: "prev",
      header: prevMonth,
      accessorFn: (m) => fmtAr(m.pick(dPrev)),
      meta: { kind: "money" },
      cell: ({ row }) => <span className="text-muted-foreground">{fmtAr(row.original.pick(dPrev))}</span>,
    },
    {
      id: "delta",
      header: "التغيّر %",
      accessorFn: (m) => deltaText(m),
      meta: { kind: "number" },
      cell: ({ row }) => {
        const pct = deltaPct(row.original.pick(d), row.original.pick(dPrev));
        const up = pct != null && Number(pct) > 0;
        const down = pct != null && Number(pct) < 0;
        return (
          <span className={`font-medium ${up ? "text-money-positive" : down ? "text-money-negative" : ""}`}>
            {deltaText(row.original)}
          </span>
        );
      },
    },
  ];
}

export default function MonthlyClosePack() {
  const [month, setMonth] = useState<string>(currentBaghdadMonth());
  const [branchId, setBranchId] = useState<number | "">("");
  const [, navigate] = useLocation();

  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.role === "admin";
  const permissionsOverride = (me.data?.permissionsOverride ??
    null) as PermissionMap | null;
  const branches = trpc.branches.list.useQuery(undefined, { enabled: isAdmin });

  const q = trpc.reports.monthlyClosePack.useQuery({
    month,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const d = q.data;

  // ش٥: جاهزية الإقفال — استعلامٌ مستقلّ يظهر ولو كانت الحزمة ما زالت تُحمَّل (هو البوّابة لا الملخّص).
  const readiness = trpc.reports.monthCloseReadiness.useQuery({
    month,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const rd = readiness.data;

  // ش٥ب: طلب الإقفال واعتماده (Maker-Checker). الطابور محصورٌ بمديرٍ فأعلى ⇒ لا يُطلَب لغيرهم
  // (الشاشة نفسها مرئيّةٌ للمحاسب/المدقّق عبر بوّابة التقارير).
  const canRequest =
    !!me.data &&
    moduleAccessAllowed(me.data.role, permissionsOverride, "reports", "FULL", [
      "manager",
    ]) &&
    (me.data.role === "admin" ||
      me.data.role === "manager" ||
      me.data.branchId != null);
  const requests = trpc.periodLock.closeRequests.useQuery(undefined, {
    enabled: canRequest,
  });
  const actionReadiness = trpc.periodLock.closeActionReadiness.useQuery(
    { month },
    { enabled: canRequest },
  );
  const actionRd = actionReadiness.data;
  const isDecember = month.endsWith("-12");
  const doubleEntryAvailability =
    trpc.reports.doubleEntryReportAvailability.useQuery(undefined, {
      enabled: canRequest && isDecember,
    });
  const useYearEnd = monthCloseUsesYearEnd(
    month,
    doubleEntryAvailability.data?.mode,
  );
  const decemberRouteUnavailable =
    isDecember &&
    (!!doubleEntryAvailability.error ||
      (!doubleEntryAvailability.isLoading && !doubleEntryAvailability.data));
  const pendingForMonth = requests.data?.find(
    (r) => r.month === month && r.status === "PENDING_APPROVAL",
  );
  const lockedApprovalForMonth = requests.data?.find(
    (r) => r.month === month && r.status === "APPROVED" && r.locked,
  );
  const historicalApprovalForMonth = requests.data?.find(
    (r) => r.month === month && r.status === "APPROVED",
  );
  const [rejectReason, setRejectReason] = useState("");

  const afterDecision = () => {
    void readiness.refetch();
    void utils.periodLock.status.invalidate();
    void utils.periodLock.history.invalidate();
    void utils.periodLock.closeRequests.invalidate();
    void utils.periodLock.closeActionReadiness.invalidate();
    setRejectReason("");
  };
  const mRequest = trpc.periodLock.requestClose.useMutation({
    onSuccess: () => {
      notify.ok("أُرسل طلب الإقفال — بانتظار اعتماد الإدارة.");
      afterDecision();
    },
    onError: (e) => notify.err(e),
  });
  const mApprove = trpc.periodLock.approveClose.useMutation({
    onSuccess: (r) => {
      notify.ok(`أُقفل شهر ${r.month}.`);
      afterDecision();
    },
    onError: (e) => notify.err(e),
  });
  const mReject = trpc.periodLock.rejectClose.useMutation({
    onSuccess: () => {
      notify.ok("رُفض الطلب.");
      afterDecision();
    },
    onError: (e) => notify.err(e),
  });
  const busy = mRequest.isPending || mApprove.isPending || mReject.isPending;

  // لقطة الذمم كما في نهاية الشهر المختار — تستبدل «لقطة الآن» بالحسّاسة للتاريخ (reports.financialPosition
  // اكتسبت asOf لهذا الغرض بالضبط). لا تُطلَب إلا بعد توفّر period.to من الاستعلام الأول.
  const posAsOf = trpc.reports.financialPosition.useQuery(
    { branchId: branchId ? Number(branchId) : undefined, asOf: d?.period.to },
    { enabled: !!d?.period.to },
  );
  const hist: { ar: string; ap: string } | null = posAsOf.data
    ? { ar: posAsOf.data.arDebit, ap: posAsOf.data.apCredit }
    : null;

  // مقارنة بالشهر السابق: نداءٌ ثانٍ بنفس الفرع لشهرٍ أقدم بواحد — يُغذّي جدول المقارنة أدناه.
  const prevMonth = previousMonth(month);
  const qPrev = trpc.reports.monthlyClosePack.useQuery({
    month: prevMonth,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const dPrev = qPrev.data;

  const branchLabel = branchId
    ? (branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId))
    : "كل الفروع";

  const readinessLabel = rd
    ? rd.blocked
      ? "غير جاهز — توجد بنود حاجزة"
      : "جاهز للإقفال"
    : "تعذّر تحديد الجاهزية";
  const requestLabel = !canRequest
    ? "قراءة فقط — لا صلاحية لطلب الإقفال"
    : lockedApprovalForMonth
      ? `مقفل — الطلب #${lockedApprovalForMonth.id}`
      : pendingForMonth
        ? `بانتظار الاعتماد — الطلب #${pendingForMonth.id}`
        : historicalApprovalForMonth
          ? `فُتح بعد اعتماد الطلب #${historicalApprovalForMonth.id} — متاح لطلب جديد`
          : "لا يوجد طلب";
  const exportReady =
    !!d &&
    !!hist &&
    !!rd &&
    (!canRequest || (!requests.isLoading && !requests.error));

  function onExport() {
    if (!d || !hist || !rd) {
      notify.err(
        "لا يمكن تصدير حزمة تاريخية ناقصة؛ أعد تحميل الجاهزية ولقطة نهاية الشهر.",
      );
      return;
    }
    exportRows(monthlyCloseExportRows(d, hist), {
      filename: `حزمة-الإقفال-الشهري-${month}`,
      title: `حزمة الإقفال الشهري — ${month}`,
      meta: monthlyCloseExportMeta(
        d,
        branchLabel,
        readinessLabel,
        requestLabel,
      ),
      columns: MONTHLY_CLOSE_EXPORT_COLUMNS,
    });
  }

  function onPrint() {
    if (!d || !hist) {
      notify.err(
        "لا يمكن طباعة حزمة تاريخية قبل اكتمال لقطة الذمم في نهاية الشهر.",
      );
      return;
    }
    printReportDoc({
      title: `حزمة الإقفال الشهري — ${month}`,
      headerExtra: [
        { label: "الفترة", value: `${d.period.from} — ${d.period.to}` },
        { label: "الفرع", value: branchLabel },
        { label: "الأساس المحاسبي", value: monthlyAccountingBasisLabel(d.accountingBasis) },
      ],
      columns: [
        { key: "section", label: "البند" },
        { key: "value", label: "القيمة", align: "left" },
      ],
      rows: closePackRows(d, hist),
      summary: [
        { label: "المصروفات", value: fmtAr(d.expenses.total) },
        { label: "صافي المبيعات", value: fmtAr(d.sales.netAfterReturns) },
        {
          label: "الربح الإجمالي",
          value: fmtAr(d.profit.profit),
        },
        {
          label: "صافي الربح",
          value: fmtAr(d.profit.netProfit),
          large: true,
          bold: true,
        },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="الإقفال الشهري"
        description="صورة الشهر المالية الموحّدة: مبيعات وربح إجمالي وصافي ومشتريات ومصاريف وخزينة وذمم — للمراجعة والطباعة."
        actions={
          <>
            <Button
              variant="outline"
              onClick={onExport}
              disabled={!exportReady}
              className="gap-1.5"
            >
              <FileSpreadsheet aria-hidden className="size-4" />
              تصدير Excel
            </Button>
            <Button
              onClick={onPrint}
              disabled={!d || !hist}
              className="gap-1.5"
            >
              <Printer aria-hidden className="size-4" />
              طباعة / PDF
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">الشهر</span>
          <MonthPicker
            value={month}
            onChange={setMonth}
            max={currentBaghdadMonth()}
            ariaLabel="شهر الإقفال"
          />
        </div>
        {isAdmin && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <AppSelect
              className="h-9"
              value={String(branchId)}
              onValueChange={(next) =>
                setBranchId(next ? Number(next) : "")
              }
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
          </div>
        )}
      </div>

      {d && posAsOf.error && (
        <Card className="border-destructive/50">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <span className="flex items-center gap-2 text-destructive">
              <CircleAlert aria-hidden className="size-4" />
              تعذّر بناء لقطة الذمم كما في نهاية الشهر؛ حُجب العرض والتصدير
              التاريخيان لمنع استخدام أرصدة اليوم مكانها.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => posAsOf.refetch()}
            >
              إعادة المحاولة
            </Button>
          </CardContent>
        </Card>
      )}

      {rd && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {rd.blocked ? (
                <CircleAlert aria-hidden className="size-4 text-destructive" />
              ) : (
                <CircleCheck aria-hidden className="size-4" />
              )}
              جاهزية الإقفال
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {rd.items.map((it) => (
              <div key={it.key} className="flex items-start gap-2">
                {it.status === "BLOCK" ? (
                  <CircleAlert
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                  />
                ) : it.status === "WARN" ? (
                  <TriangleAlert
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <CircleCheck
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <div>
                  <div
                    className={
                      it.status === "BLOCK"
                        ? "font-medium text-destructive"
                        : "font-medium"
                    }
                  >
                    {it.label}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {it.detail}
                  </div>
                </div>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              {rd.blocked
                ? "لا يُقفَل الشهر ما دام بندٌ حاجزٌ قائماً — عالجه ثم أعِد الفحص."
                : "لا مانع من الإقفال. بنود التنبيه لا تحجب."}
            </p>

            {canRequest && (
              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                {lockedApprovalForMonth ? (
                  <span className="text-xs text-muted-foreground">
                    هذا الشهر مُقفَلٌ باعتماد الطلب رقم{" "}
                    {lockedApprovalForMonth.id}.
                  </span>
                ) : pendingForMonth ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      طلب إقفالٍ معلَّق (طلبه {pendingForMonth.requestedByName})
                      — بانتظار اعتماد الإدارة.
                    </span>
                    {isAdmin && (
                      <>
                        {useYearEnd ? (
                          <Button
                            size="sm"
                            onClick={() =>
                              navigate(
                                yearEndCloseHref(month, pendingForMonth.id),
                              )
                            }
                          >
                            متابعة الإقفال السنوي
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={monthCloseApprovalDisabled({
                              busy,
                              readinessLoading: actionReadiness.isLoading,
                              readinessError: !!actionReadiness.error,
                              readinessBlocked: actionRd?.blocked,
                              routeLoading:
                                isDecember && doubleEntryAvailability.isLoading,
                              routeError: decemberRouteUnavailable,
                            })}
                            onClick={() =>
                              mApprove.mutate({ requestId: pendingForMonth.id })
                            }
                          >
                            اعتماد الإقفال
                          </Button>
                        )}
                        <input
                          className={selectCls}
                          placeholder="سبب الرفض"
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          aria-label="سبب رفض طلب الإقفال"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || rejectReason.trim().length < 5}
                          onClick={() =>
                            mReject.mutate({
                              requestId: pendingForMonth.id,
                              reason: rejectReason.trim(),
                            })
                          }
                        >
                          رفض
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {useYearEnd
                            ? "ديسمبر في وضع ACTIVE يُستكمل من الإقفال السنوي بعد ترحيل الأرباح المحتجزة."
                            : actionReadiness.isLoading ||
                                (isDecember &&
                                  doubleEntryAvailability.isLoading)
                              ? "جارٍ إعادة التحقق الحي من جاهزية الاعتماد…"
                              : actionReadiness.error ||
                                  decemberRouteUnavailable
                                ? "تعذّر التحقق؛ الاعتماد محجوب احترازياً."
                                : actionRd?.blocked
                                  ? "الاعتماد محجوب لأن جاهزية الشركة تغيّرت بعد الطلب."
                                  : "الجاهزية العامة ما زالت مكتملة للاعتماد."}
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        actionReadiness.isLoading ||
                        !!actionReadiness.error ||
                        actionRd?.blocked !== false
                      }
                      onClick={() => mRequest.mutate({ month })}
                    >
                      طلب إقفال الشهر
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {actionReadiness.isLoading
                        ? "جارٍ التحقق من جاهزية الشركة كلها…"
                        : actionReadiness.error
                          ? "تعذّر التحقق من الجاهزية العامة؛ الطلب محجوب احترازياً."
                          : actionRd?.blocked
                            ? "مُعطَّل لوجود بنود حاجزة في الشركة؛ لا تُعرَض تفاصيل الفروع الأخرى هنا."
                            : "جاهزية الشركة مكتملة؛ يُرسَل الطلب للإدارة لاعتماده — الطالب لا يعتمد طلبه."}
                    </span>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            <StatCard
              label="صافي المبيعات بعد المرتجعات"
              value={fmtAr(d.sales.netAfterReturns)}
              sub={`${d.sales.invoiceCount} فاتورة — مرتجعات ${fmtAr(d.sales.returnedTotal)}`}
              icon={ReceiptText}
              tone="info"
            />
            <StatCard
              label="الربح الإجمالي"
              value={fmtAr(d.profit.profit)}
              sub={`تكلفة ${fmtAr(d.profit.cost)}`}
              icon={TrendingUp}
              tone={D(d.profit.profit).lt(0) ? "negative" : "positive"}
            />
            <StatCard
              label="المشتريات"
              value={fmtAr(d.purchases.total)}
              sub={`${d.purchases.orderCount} أمراً — متبقٍّ ${fmtAr(d.purchases.unpaid)}`}
              icon={ShoppingCart}
            />
            <StatCard
              label="المصروفات"
              value={fmtAr(d.expenses.total)}
              icon={Wallet}
              tone="warning"
            />
            <StatCard
              label="صافي الربح"
              value={fmtAr(d.profit.netProfit)}
              sub={monthlyAccountingBasisLabel(d.accountingBasis)}
              icon={TrendingUp}
              tone={D(d.profit.netProfit).isNegative() ? "negative" : "positive"}
            />
            <StatCard
              label="صافي حركة الخزينة"
              value={fmtAr(d.treasury.net)}
              sub={`دخل ${fmtAr(d.treasury.totalIn)} — خرج ${fmtAr(d.treasury.totalOut)}`}
              icon={Scale}
            />
            <StatCard
              label="ذمم العملاء (كما في نهاية الشهر)"
              value={hist ? fmtAr(hist.ar) : "غير متاح"}
              icon={ReceiptText}
            />
            <StatCard
              label="ذمم الموردين (كما في نهاية الشهر)"
              value={hist ? fmtAr(hist.ap) : "غير متاح"}
              icon={ReceiptText}
            />
            <StatCard
              label="أوامر شغل مُسلَّمة"
              value={String(d.workOrdersDelivered)}
              icon={Wrench}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                تفصيل المبيعات والضريبة
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">
                  صافٍ قبل الضريبة
                </div>
                <div className="tabular-nums" dir="ltr">
                  {fmtAr(d.sales.subtotal)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">الضريبة</div>
                <div className="tabular-nums" dir="ltr">
                  {fmtAr(d.sales.tax)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">الإجمالي</div>
                <div className="tabular-nums" dir="ltr">
                  {fmtAr(d.sales.total)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">المرتجعات</div>
                <div className="tabular-nums text-money-negative" dir="ltr">
                  {fmtAr(d.sales.returnedTotal)}
                </div>
              </div>
            </CardContent>
          </Card>

          {d.expenses.topCategories.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">أعلى فئات المصروفات</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {d.expenses.topCategories.map((c) => (
                  <div
                    key={c.category}
                    className="flex items-center justify-between"
                  >
                    <span>{c.category}</span>
                    <span className="tabular-nums" dir="ltr">
                      {fmtAr(c.total)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                مقارنة بالشهر السابق ({prevMonth})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {qPrev.isLoading ? (
                <LoadingState />
              ) : !dPrev ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  تعذّر تحميل بيانات الشهر السابق للمقارنة.
                </p>
              ) : (
                /* مُضمَّن: البطاقة تحمل عنوان المقارنة، وستّةُ بنودٍ ثابتة لا تحتاج بحثاً ولا ترقيماً. */
                <DataTable<CompareMetric>
                  embedded
                  searchable={false}
                  bounded={false}
                  pageSize={Infinity}
                  data={COMPARE_METRICS}
                  columns={compareColumns(d, dPrev, month, prevMonth)}
                />
              )}
            </CardContent>
          </Card>

          <p className="text-[11px] text-muted-foreground">
            {hist
              ? "ذمم العملاء/الموردين أعلاه مبنيّة من الدفتر حتى نهاية الشهر المختار (لا الآن)."
              : posAsOf.isLoading
                ? "جارٍ بناء لقطة الذمم كما في نهاية الشهر…"
                : "لقطة الذمم التاريخية غير متاحة؛ لم تُستبدل بأرصدة اليوم، والتصدير والطباعة محجوبان حتى نجاح إعادة التحميل."}{" "}
            أقسام الشهر (مبيعات/ربح/مشتريات/مصاريف/خزينة) محسوبة على نطاق{" "}
            {d.period.from} إلى {d.period.to} على أساس {monthlyAccountingBasisLabel(d.accountingBasis)}.
          </p>
        </>
      ) : null}
    </div>
  );
}
