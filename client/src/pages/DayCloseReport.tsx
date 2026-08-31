// تقرير «مطابقة إقفال اليوم للنقد» — يوازن نقد الدرج لكل وردية في يومٍ وفرع:
//   المتوقَّع (من الدفتر) مقابل المعدود (نقد الإغلاق) مقابل الفرق (drift = variance الوردية).
// عهد الإغلاق الخارجة من الدرج تُعرَض منفصلةً؛ قبولها الفعلي يظهر في قسم جرد الخزينة.
import { shiftTypeLabel } from "@/lib/labels";
import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Wallet, Building2, Clock, ArrowLeftRight, ChevronLeft, ChevronRight, Vault, LockKeyhole, RotateCcw } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { selectCls } from "@/lib/ui/formStyles";
import { CashCounter } from "@/components/CashCounter";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { newClientRequestId } from "@/lib/countQueue";
import { D } from "@/lib/money";
import { Link } from "wouter";
import { moduleAccessAllowed } from "@shared/permissions";

type DC = RouterOutputs["reports"]["dayCloseReconciliation"];


const NOTE =
  "المتوقَّع = الرصيد الافتتاحي + المقبوضات النقدية − المرتجعات والمصروفات النقدية (النقد فقط، درج الكاشير). " +
  "عهد الإغلاق تُعرَض منفصلةً ولا تُطرَح من المتوقَّع لأنها غادرت الدرج بعد العدّ؛ خروجها لا يعني أن الخزينة قبلتها. «المتبقّي في الدرج» = المعدود − العهد الخارجة. " +
  "الفرق = المعدود − المتوقَّع (يطابق فرق الوردية في تقرير Z): موجب = فائض، سالب = عجز.";

/** تاريخ اليوم YYYY-MM-DD (UTC) — قيمة ابتدائية لمنتقي التاريخ. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** تسمية عربية لنوع الوردية (درجٌ مستقلّ لكل نوع: تجزئة / استقبال / خدمات طباعة). */

export default function DayCloseReport() {
  const [date, setDate] = useState<string>(todayUtc);
  const [branchId, setBranchId] = useState<number | "">("");
  const [treasuryBreakdown, setTreasuryBreakdown] = useState<Record<number, number>>({});
  const [treasuryCounted, setTreasuryCounted] = useState("0.00");
  const [treasuryNotes, setTreasuryNotes] = useState("");
  const [countRequestId, setCountRequestId] = useState(newClientRequestId);
  const [closeRequestId, setCloseRequestId] = useState(newClientRequestId);
  const [reopenReason, setReopenReason] = useState("");
  const branches = trpc.branches.list.useQuery();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  const q = trpc.reports.dayCloseReconciliation.useQuery({
    date,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const dc: DC | undefined = q.data;
  const dailyQ = trpc.treasury.dailyCashReconciliation.useQuery(
    { branchId: Number(branchId || 0), businessDate: date },
    { enabled: branchId !== "" },
  );
  const userRole = me.data?.role ?? "";
  const canManageDaily = moduleAccessAllowed(
    userRole,
    (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)
      ?.permissionsOverride ?? null,
    "treasury",
    "FULL",
    ["manager", "accountant"],
  );
  useEffect(() => {
    setTreasuryBreakdown({});
    setTreasuryCounted("0.00");
    setTreasuryNotes("");
    setCountRequestId(newClientRequestId());
    setCloseRequestId(newClientRequestId());
    setReopenReason("");
  }, [branchId, date]);
  const recordDailyM = trpc.treasury.recordDailyTreasuryCount.useMutation({
    onSuccess: (result) => {
      if (result.status === "MATCHED") notify.ok("سُجّل جرد الخزينة", "الرصيد الفعلي مطابق لرصيد النظام.");
      else notify.warn(`فرق خزينة ${fmtAr(result.variance)} د.ع`, "حُفظ الجرد ولم تُنشأ أي حركة مالية. صحّح المصدر ثم أعد العد.");
      setCountRequestId(newClientRequestId());
      void utils.treasury.dailyCashReconciliation.invalidate();
      void utils.reports.dayCloseReconciliation.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const closeDailyM = trpc.treasury.closeDailyCashReconciliation.useMutation({
    onSuccess: () => {
      notify.ok("أُغلقت المطابقة اليومية", "حُفظت شهادة الجرد والأدلة المحاسبية.");
      setCloseRequestId(newClientRequestId());
      void utils.treasury.dailyCashReconciliation.invalidate();
    },
    onError: (error) => notify.err(error),
  });
  const reopenDailyM = trpc.treasury.reopenDailyCashReconciliation.useMutation({
    onSuccess: () => {
      notify.ok("أُعيد فتح المطابقة", "يلزم جرد جديد قبل الإقفال مرة أخرى.");
      setReopenReason("");
      void utils.treasury.dailyCashReconciliation.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const branchLabel = branchId
    ? branches.data?.find((b) => b.id === branchId)?.name ?? String(branchId)
    : "كل الفروع";

  const driftTone = (drift: string | null): "positive" | "negative" | "warning" | "default" => {
    if (drift == null) return "default";
    const n = Number(drift);
    if (n === 0) return "positive";
    return n > 0 ? "warning" : "negative";
  };

  const kpis: KpiItem[] = dc
    ? [
        { label: "المتوقَّع في الدرج", value: fmtAr(dc.totals.expected), tone: "info", hint: "الرصيد الافتتاحي + المقبوضات − المرتجعات والمصروفات" },
        { label: "المعدود عند الإغلاق", value: fmtAr(dc.totals.counted), tone: "default", hint: `${dc.totals.closedCount} وردية مغلقة` },
        { label: "الفرق (فائض/عجز)", value: fmtAr(dc.totals.drift), tone: driftTone(dc.totals.drift), hint: dc.driftCount === 0 ? "كل الورديات مطابقة" : `${dc.driftCount} وردية بفرق` },
        { label: "خرج إلى العهدة", value: fmtAr(dc.totals.handoversCash), tone: "default", hint: `المتبقّي في الأدراج: ${fmtAr(dc.totals.retainedInDrawer)}` },
      ]
    : [];

  const daily = dailyQ.data;
  const saved = daily?.reconciliation;
  const dailyPanel = branchId === "" ? (
    <Card>
      <CardContent className="p-5 text-sm text-muted-foreground">
        اختر فرعاً محدداً لعرض رصيد الخزينة الفعلي وتسجيل جرد اليوم. «كل الفروع» متاح لتقرير الورديات فقط.
      </CardContent>
    </Card>
  ) : dailyQ.isLoading ? (
    <Card><CardContent className="p-5"><LoadingState /></CardContent></Card>
  ) : dailyQ.isError ? (
    <Card><CardContent className="p-5"><ErrorState message="تعذّر تحميل مطابقة الخزينة؛ لم يُفترض رصيد صفري." onRetry={() => void dailyQ.refetch()} /></CardContent></Card>
  ) : (
    <Card className={saved?.status === "CLOSED" ? "border-money-positive/40" : saved && !D(saved.variance).isZero() ? "border-money-negative/40" : undefined}>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 font-bold"><Vault className="size-4" /> جرد الخزينة الفعلي</div>
            <p className="mt-1 text-xs text-muted-foreground">الجرد إثبات مادي فقط؛ لا ينشئ سند تسوية ولا يغيّر الرصيد الدفتري.</p>
          </div>
          <div className="text-left">
            <p className="text-xs text-muted-foreground">رصيد النظام</p>
            <p className="text-xl font-bold tabular-nums" dir="ltr">{fmtAr(daily?.expectedTreasuryCash ?? "0")}</p>
          </div>
        </div>

        {(daily?.blockers.length ?? 0) > 0 && (
          <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn)]/5 p-3 text-xs">
            <p className="mb-1 font-bold">عوائق المطابقة</p>
            <ul className="list-disc space-y-1 pr-5">
              {daily?.blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`}>
                  {blocker.message}{blocker.amount ? ` — ${fmtAr(blocker.amount)} د.ع` : ""}
                </li>
              ))}
            </ul>
            {daily?.blockers.some((blocker) => blocker.code === "PENDING_CUSTODY") && (
              <Link href="/treasury?tab=dashboard" className="mt-2 inline-block font-bold text-primary underline">فتح طابور عهد الاستلام</Link>
            )}
          </div>
        )}

        {saved && (
          <div className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-4">
            <div><p className="text-[11px] text-muted-foreground">الحالة</p><p className="font-bold">{saved.status === "CLOSED" ? "مغلقة" : saved.status === "MATCHED" ? "مطابقة" : saved.status === "RESOLVED_WITH_ADJUSTMENT" ? "محلول بسند تصحيح" : saved.status === "VARIANCE_OPEN" ? "فرق مفتوح" : "معاد فتحها"}</p></div>
            <div><p className="text-[11px] text-muted-foreground">المعدود فعلياً</p><p className="font-bold tabular-nums" dir="ltr">{fmtAr(saved.countedTreasuryCash)}</p></div>
            <div><p className="text-[11px] text-muted-foreground">الفرق</p><p className={`font-bold tabular-nums ${D(saved.variance).isZero() ? "text-money-positive" : "text-money-negative"}`} dir="ltr">{fmtAr(saved.variance)}</p></div>
            <div><p className="text-[11px] text-muted-foreground">الإصدار</p><p className="font-bold tabular-nums" dir="ltr">#{saved.version}</p></div>
            {daily?.resolution && (
              <div><p className="text-[11px] text-muted-foreground">رقم قضية فرق النقد</p><p className="font-bold tabular-nums" dir="ltr">#{daily.resolution.caseId}</p></div>
            )}
          </div>
        )}

        {daily?.actions.canCount && canManageDaily && (
          <div className="space-y-3 border-t pt-4">
            <CashCounter
              value={treasuryBreakdown}
              onChange={(counts, total) => { setTreasuryBreakdown(counts); setTreasuryCounted(total); }}
              disabled={recordDailyM.isPending}
            />
            <Textarea value={treasuryNotes} onChange={(event) => setTreasuryNotes(event.target.value)} maxLength={500} placeholder="ملاحظات الجرد (اختياري)" />
            <Button
              disabled={recordDailyM.isPending || !countRequestId}
              onClick={() => recordDailyM.mutate({
                branchId: Number(branchId),
                businessDate: date,
                countedCash: treasuryCounted,
                countedBreakdown: Object.fromEntries(Object.entries(treasuryBreakdown).map(([key, value]) => [String(key), value])),
                notes: treasuryNotes || null,
                expectedVersion: saved ? Number(saved.version) : 0,
                clientRequestId: countRequestId,
              })}
            >
              {recordDailyM.isPending ? "جارٍ تسجيل الجرد…" : saved ? "إعادة جرد الخزينة" : "تسجيل جرد الخزينة"}
            </Button>
          </div>
        )}

        {daily?.actions.canClose && saved && canManageDaily && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-xs text-muted-foreground">الإقفال يحتاج مستخدماً مختلفاً عن منفّذ الجرد، باستثناء الإداري.</p>
            <Button
              onClick={() => closeDailyM.mutate({ reconciliationId: Number(saved.id), expectedVersion: Number(saved.version), clientRequestId: closeRequestId })}
              disabled={closeDailyM.isPending}
              className="gap-1.5"
            >
              <LockKeyhole className="size-4" /> {closeDailyM.isPending ? "جارٍ الإقفال…" : "اعتماد وإقفال اليوم"}
            </Button>
          </div>
        )}

        {daily?.actions.canReopen && saved?.status === "CLOSED" && canManageDaily && (
          <div className="space-y-2 border-t pt-4">
            <Textarea value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} maxLength={500} placeholder="سبب إعادة الفتح (10 أحرف على الأقل)" />
            <Button variant="outline" disabled={reopenDailyM.isPending || reopenReason.trim().length < 10} onClick={() => reopenDailyM.mutate({ reconciliationId: Number(saved.id), reason: reopenReason.trim() })} className="gap-1.5">
              <RotateCcw className="size-4" /> إعادة فتح المطابقة
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );

  function onExport() {
    if (!dc) return;
    exportRows(dc.shifts, {
      filename: `مطابقة-إقفال-اليوم-${date}-${branchId || "الكل"}`,
      columns: [
        { key: "shiftId", header: "الوردية", map: (r) => `#${r.shiftId}` },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName ?? "" },
        { key: "userName", header: "الكاشير", map: (r) => r.userName ?? "" },
        { key: "shiftType", header: "النوع", map: (r) => shiftTypeLabel(r.shiftType) },
        { key: "status", header: "الحالة", map: (r) => (r.status === "CLOSED" ? "مغلقة" : "مفتوحة") },
        { key: "opening", header: "افتتاحي", map: (r) => Number(r.opening) },
        { key: "salesCash", header: "مبيعات نقدية", map: (r) => Number(r.salesCash) },
        { key: "collectionsCash", header: "تحصيلات", map: (r) => Number(r.collectionsCash) },
        { key: "otherIn", header: "مقبوضات أخرى", map: (r) => Number(r.otherIn) },
        { key: "cashIn", header: "إجمالي الداخل", map: (r) => Number(r.cashIn) },
        { key: "returnsCash", header: "مرتجعات", map: (r) => Number(r.returnsCash) },
        { key: "expensesCash", header: "مصروفات/سندات", map: (r) => Number(r.expensesCash) },
        { key: "otherOut", header: "مصروفات أخرى", map: (r) => Number(r.otherOut) },
        { key: "cashDrops", header: "سحب أثناء الوردية", map: (r) => Number(r.cashDrops) },
        { key: "operatingOut", header: "إجمالي الخارج التشغيلي", map: (r) => Number(r.operatingOut) },
        { key: "expected", header: "المتوقَّع", map: (r) => Number(r.expected) },
        { key: "counted", header: "المعدود", map: (r) => (r.counted == null ? "" : Number(r.counted)) },
        { key: "drift", header: "الفرق", map: (r) => (r.drift == null ? "" : Number(r.drift)) },
        { key: "handoversCash", header: "خرج إلى العهدة", map: (r) => Number(r.handoversCash) },
        { key: "retainedInDrawer", header: "المتبقّي بالدرج", map: (r) => (r.retainedInDrawer == null ? "" : Number(r.retainedInDrawer)) },
      ],
    });
  }

  // طباعة A4 — نفس أعمدة الشاشة/التصدير (تفصيل كل وردية)، ولا اقتطاع (اليوم الواحد محدودُ الورديات أصلاً).
  function onPrint() {
    if (!dc) return;
    const opened = printReportDoc({
      title: "مطابقة إقفال اليوم للنقد",
      headerExtra: [
        { label: "التاريخ", value: fmtDate(date) },
        { label: "الفرع", value: branchLabel },
      ],
      note: NOTE,
      orientation: "landscape",
      columns: [
        { key: "shiftId", label: "الوردية" },
        { key: "branch", label: "الفرع" },
        { key: "cashier", label: "الكاشير" },
        { key: "status", label: "الحالة" },
        { key: "expected", label: "المتوقَّع", align: "left" },
        { key: "counted", label: "المعدود", align: "left" },
        { key: "drift", label: "الفرق", align: "left" },
        { key: "handovers", label: "خرج إلى العهدة", align: "left" },
      ],
      rows: dc.shifts.map((r) => ({
        shiftId: `#${r.shiftId}`,
        branch: r.branchName ?? "—",
        cashier: r.userName ?? "—",
        status: r.status === "CLOSED" ? "مغلقة" : "مفتوحة",
        expected: fmtAr(r.expected),
        counted: r.counted == null ? "—" : fmtAr(r.counted),
        drift: r.drift == null ? "—" : fmtAr(r.drift),
        handovers: fmtAr(r.handoversCash),
      })),
      summary: [
        { label: "المعدود عند الإغلاق", value: formatIqd(dc.totals.counted) },
        { label: "الفرق (فائض/عجز)", value: formatIqd(dc.totals.drift), large: true, bold: true },
      ],
    });
    if (!opened) alert("حجب المتصفح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
  }

  // تنقّل سريع ليوم سابق/تالٍ (لا يتجاوز اليوم — نفس سقف منتقي التاريخ أدناه).
  function shiftDay(deltaDays: number) {
    const d = new Date(`${date}T00:00:00Z`);
    if (isNaN(d.getTime())) return;
    d.setUTCDate(d.getUTCDate() + deltaDays);
    const next = d.toISOString().slice(0, 10);
    setDate(next > todayUtc() ? todayUtc() : next);
  }

  return (
    <ReportShell
      title="مطابقة إقفال اليوم للنقد"
      description="مطابقة نقد درج الكاشير لكل وردية: المتوقَّع مقابل المعدود مقابل الفرق — بحبيبة الوردية والفرع."
      note={NOTE}
      kpis={kpis}
      onExport={onExport}
      onPrint={onPrint}
      exportDisabled={!dc || dc.shifts.length === 0}
      printDisabled={!dc || dc.shifts.length === 0}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">تاريخ اليوم</label>
            <input
              type="date"
              className={selectCls}
              value={date}
              max={todayUtc()}
              onChange={(e) => setDate(e.target.value || todayUtc())}
            />
          </div>
          {/* تنقّل سريع ليوم سابق/تالٍ. */}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" title="اليوم السابق" aria-label="اليوم السابق" onClick={() => shiftDay(-1)}>
              <ChevronRight aria-hidden className="size-3.5" />
            </Button>
            <Button variant="outline" size="sm" title="اليوم التالي" aria-label="اليوم التالي" disabled={date >= todayUtc()} onClick={() => shiftDay(1)}>
              <ChevronLeft aria-hidden className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">الفرع</label>
            <select
              className={selectCls}
              value={branchId}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">كل الفروع</option>
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
      {q.isLoading ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState message="تعذّر تحميل التقرير." onRetry={() => void q.refetch()} />
      ) : !dc ? (
        <LoadingState />
      ) : dc.shifts.length === 0 ? (
        <div className="space-y-4">
          {dailyPanel}
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              لا ورديات في {fmtDate(date)} لـ{branchLabel}.
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          {dailyPanel}
          <ReconciliationHero dc={dc} />
          <ShiftTable dc={dc} />
        </div>
      )}
    </ReportShell>
  );
}

/** لوحة «المتوقَّع مقابل المعدود مقابل الفرق» — بلونٍ دلاليّ واضح على مجموع اليوم. */
function ReconciliationHero({ dc }: { dc: DC }) {
  const drift = Number(dc.totals.drift);
  const balanced = dc.driftCount === 0 && dc.totals.counted !== "0.00";
  const driftCls = drift === 0 ? "text-money-positive" : drift > 0 ? "text-stock-low" : "text-money-negative";
  const driftLabel = drift === 0 ? "مطابق" : drift > 0 ? "فائض" : "عجز";

  return (
    <Card className={balanced ? "border-money-positive/40" : dc.driftCount > 0 ? "border-money-negative/40" : undefined}>
      <CardContent className="p-4">
        <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          {/* المتوقَّع */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">المتوقَّع في الدرج</p>
            <p className="text-2xl font-bold tabular-nums text-[var(--sem-info)]" dir="ltr">{fmtAr(dc.totals.expected)}</p>
          </div>
          <div className="hidden text-muted-foreground sm:block" aria-hidden>
            <ArrowLeftRight className="size-5" />
          </div>
          {/* المعدود */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">المعدود عند الإغلاق</p>
            <p className="text-2xl font-bold tabular-nums" dir="ltr">{fmtAr(dc.totals.counted)}</p>
          </div>
          <div className="hidden text-muted-foreground sm:block" aria-hidden>=</div>
          {/* الفرق */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">الفرق</p>
            <p className={`inline-flex items-center justify-center gap-1 text-2xl font-bold tabular-nums ${driftCls}`} dir="ltr">
              {drift === 0 ? (
                <CheckCircle2 aria-hidden className="size-5" />
              ) : (
                <AlertTriangle aria-hidden className="size-5" />
              )}
              {fmtAr(dc.totals.drift)}
            </p>
            <p className={`mt-0.5 text-[11px] font-medium ${driftCls}`}>{driftLabel}</p>
          </div>
        </div>

        {/* سطر جسر التسليم (إن وُجد) */}
        {dc.totals.handoversCash !== "0.00" && (
          <p className="mt-3 border-t pt-2 text-center text-xs text-muted-foreground">
            خرج إلى عهدة مستلمين: <span className="font-semibold tabular-nums text-foreground" dir="ltr">{fmtAr(dc.totals.handoversCash)}</span>
            {"  —  "}المتبقّي فعلاً في الأدراج: <span className="font-semibold tabular-nums text-foreground" dir="ltr">{fmtAr(dc.totals.retainedInDrawer)}</span>
          </p>
        )}

        {/* ش٦ — سطرا الاستقبال: عرابين معلّقة (لقطة حاضرة) + الخصم اليدويّ لكل موظف */}
        {dc.receptionExtras.fundedDrafts.count > 0 && (
          <p className="mt-2 border-t pt-2 text-center text-xs text-[var(--sem-warn)]">
            طلبات محفوظة عليها عرابين لم تُثبَّت بعد:{" "}
            <span className="font-bold tabular-nums" dir="ltr">{dc.receptionExtras.fundedDrafts.count}</span>
            {" طلباً بمجموع "}
            <span className="font-bold tabular-nums" dir="ltr">{fmtAr(dc.receptionExtras.fundedDrafts.heldNet)}</span>
            {" د.ع (مال زبائن محتجزٌ بلا فاتورة — لقطة الآن لا اليوم)"}
          </p>
        )}
        {dc.receptionExtras.discountByUser.length > 0 && (
          <div className="mt-2 border-t pt-2 text-center text-xs text-muted-foreground">
            <span className="font-bold">الخصم اليدويّ اليوم لكل موظف: </span>
            {dc.receptionExtras.discountByUser.map((u, i) => (
              <span key={u.userId ?? i} className="mx-1 inline-block whitespace-nowrap">
                {u.userName}: <span className="font-semibold tabular-nums text-foreground" dir="ltr">{fmtAr(u.manualDiscount)}</span>
                {" "}({u.avgRatePct}% من {u.invoiceCount} فاتورة)
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** جدول تفصيل الورديات. */
function ShiftTable({ dc }: { dc: DC }) {
  return (
    <Card>
      <CardContent className="p-0">
        <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                <th className="p-3 text-right font-medium">الوردية</th>
                <th className="p-3 text-right font-medium">الكاشير</th>
                <th className="p-3 text-right font-medium">افتتاحي</th>
                <th className="p-3 text-right font-medium">داخل نقدي</th>
                <th className="p-3 text-right font-medium">خارج تشغيلي</th>
                <th className="p-3 text-right font-medium">المتوقَّع</th>
                <th className="p-3 text-right font-medium">المعدود</th>
                <th className="p-3 text-right font-medium">الفرق</th>
                <th className="p-3 text-right font-medium">خرج إلى العهدة</th>
              </tr>
            </thead>
            <tbody>
              {dc.shifts.map((sh) => {
                const drift = sh.drift == null ? null : Number(sh.drift);
                const driftCls =
                  drift == null ? "text-muted-foreground" : drift === 0 ? "text-money-positive" : drift > 0 ? "text-stock-low" : "text-money-negative";
                return (
                  <tr key={sh.shiftId} className="border-b last:border-0">
                    <td className="p-3 text-right">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs" dir="ltr">#{sh.shiftId}</span>
                        {sh.shiftType !== "RETAIL" && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{shiftTypeLabel(sh.shiftType)}</span>
                        )}
                        {sh.status === "OPEN" ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] badge-status-pending">
                            <Clock aria-hidden className="size-2.5" />مفتوحة
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Building2 aria-hidden className="size-2.5" />
                        {sh.branchName ?? "—"}
                      </div>
                    </td>
                    <td className="p-3 text-right text-xs">{sh.userName ?? "—"}</td>
                    <td className="p-3 text-right tabular-nums text-xs" dir="ltr">{fmtAr(sh.opening)}</td>
                    <td className="p-3 text-right tabular-nums text-xs text-money-positive" dir="ltr" title={`مبيعات ${fmtAr(sh.salesCash)} · تحصيلات ${fmtAr(sh.collectionsCash)} · أخرى ${fmtAr(sh.otherIn)}`}>
                      {fmtAr(sh.cashIn)}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-money-negative" dir="ltr" title={`مرتجعات ${fmtAr(sh.returnsCash)} · مصروفات ${fmtAr(sh.expensesCash)} · سحب أثناء الوردية ${fmtAr(sh.cashDrops)} · أخرى ${fmtAr(sh.otherOut)}`}>
                      {fmtAr(sh.operatingOut)}
                    </td>
                    <td className="p-3 text-right font-semibold tabular-nums text-[var(--sem-info)]" dir="ltr">{fmtAr(sh.expected)}</td>
                    <td className="p-3 text-right tabular-nums" dir="ltr">{sh.counted == null ? "—" : fmtAr(sh.counted)}</td>
                    <td className={`p-3 text-right font-semibold tabular-nums ${driftCls}`} dir="ltr">
                      {sh.drift == null ? (
                        <span className="text-[10px] text-muted-foreground">مفتوحة</span>
                      ) : (
                        <span className="inline-flex items-center justify-end gap-1">
                          {drift === 0 ? <CheckCircle2 aria-hidden className="size-3.5" /> : <AlertTriangle aria-hidden className="size-3.5" />}
                          {fmtAr(sh.drift)}
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-right tabular-nums text-xs text-muted-foreground" dir="ltr">
                      {sh.handoversCash === "0.00" ? "—" : fmtAr(sh.handoversCash)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 bg-muted/30 font-bold">
                <td className="p-3 text-right" colSpan={2}>
                  الإجمالي ({dc.totals.shiftCount} وردية · {dc.balancedCount} مطابقة · {dc.driftCount} بفرق)
                </td>
                <td className="p-3 text-right tabular-nums text-xs" dir="ltr">{fmtAr(dc.totals.opening)}</td>
                <td className="p-3 text-right tabular-nums text-xs text-money-positive" dir="ltr">{fmtAr(dc.totals.cashIn)}</td>
                <td className="p-3 text-right tabular-nums text-xs text-money-negative" dir="ltr">{fmtAr(dc.totals.operatingOut)}</td>
                <td className="p-3 text-right tabular-nums text-[var(--sem-info)]" dir="ltr">{fmtAr(dc.totals.expected)}</td>
                <td className="p-3 text-right tabular-nums" dir="ltr">{fmtAr(dc.totals.counted)}</td>
                <td className={`p-3 text-right tabular-nums ${Number(dc.totals.drift) === 0 ? "text-money-positive" : Number(dc.totals.drift) > 0 ? "text-stock-low" : "text-money-negative"}`} dir="ltr">
                  {fmtAr(dc.totals.drift)}
                </td>
                <td className="p-3 text-right tabular-nums text-xs text-muted-foreground" dir="ltr">{fmtAr(dc.totals.handoversCash)}</td>
              </tr>
            </tfoot>
          </table>
        </ScrollTableShell>
      </CardContent>
    </Card>
  );
}
