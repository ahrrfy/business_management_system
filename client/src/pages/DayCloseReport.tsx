// تقرير «مطابقة إقفال اليوم للنقد» بطبقتين منفصلتين:
//   ١) موضع النقد النهائي التراكمي حسب مكانه. ٢) حركة اليوم التي تفسّر تغيّر ذلك الموضع.
// لا تُجمع حركة اليوم أو وردية أُغلقت ونُقلت للخزينة مرةً ثانية مع رصيد الخزينة.
import { shiftTypeLabel } from "@/lib/labels";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { AppSelect } from "@/components/ui/AppSelect";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle, Wallet, Building2, Clock, ArrowLeftRight, ChevronLeft, ChevronRight, Vault, LockKeyhole, RotateCcw } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ReportShell, type KpiItem } from "@/components/reports/ReportShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState, ErrorState } from "@/components/PageState";
import { fmtAr, formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { printReportDoc } from "@/lib/printing/reportDoc";

import { selectCls } from "@/lib/ui/formStyles";
import { CashCounter } from "@/components/CashCounter";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { newClientRequestId } from "@/lib/countQueue";
import { D } from "@/lib/money";
import { Link } from "wouter";
import { moduleAccessAllowed } from "@shared/permissions";
import { MissedDailyCountExceptionPanel } from "@/components/cash/MissedDailyCountExceptionPanel";
import { DayCloseCellDetailsHover } from "@/components/treasury/DayCloseCellDetailsHover";
import { DirectOperationsPanel } from "@/components/treasury/DirectOperationsPanel";

type DC = RouterOutputs["reports"]["dayCloseReconciliation"];


const NOTE =
  "معادلة المطابقة الحاكمة: النقد المتوقع تحت السيطرة = رصيد الخزينة الدفتري التراكمي + نقد الأدراج المفتوحة + النقد بالعهدة في الطريق. " +
  "عند الإقفال النهائي يجب أن تكون الورديات والعهد مغلقة، فيساوي النقد المعدود فعلياً الرقم النهائي المتوقع، والفرق = المعدود − المتوقع. " +
  "جدول الورديات وحركات اليوم يفسّر الحركة فقط، وليس رصيداً نهائياً يُجمع مرة ثانية مع الخزينة.";

/** تاريخ اليوم YYYY-MM-DD (UTC) — قيمة ابتدائية لمنتقي التاريخ. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** تسمية عربية لنوع الوردية (درجٌ مستقلّ لكل نوع: تجزئة / استقبال / خدمات طباعة). */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function DirectMovementsCard({ dm }: { dm: NonNullable<DC["directMovements"]> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card className="border-[var(--sem-info)]/30 bg-blue-50/50 dark:bg-blue-900/10">
        <CardContent className="flex items-center justify-between p-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[var(--sem-info)] font-semibold">
              يوجد {dm.count} حركة نقدية مباشرة (خارج الأدراج) بصافي:
            </span>
            <span className="font-bold tabular-nums" dir="ltr">{fmtAr(dm.net)} د.ع</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>التفاصيل</Button>
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>العمليات والتدفقات النقدية المباشرة (خارج أدراج الورديات)</DialogTitle>
          </DialogHeader>
          <div className="p-4 space-y-4">
            <div className="text-sm text-muted-foreground">
              {dm.count} عمليات
            </div>
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الوقت</TableHead>
                    <TableHead>الموظف</TableHead>
                    <TableHead>النوع</TableHead>
                    <TableHead>البيان</TableHead>
                    <TableHead className="text-left">المبلغ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dm.details.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="tabular-nums" dir="ltr">{new Date(d.time).toLocaleTimeString('en-US')}</TableCell>
                      <TableCell>{d.userName}</TableCell>
                      <TableCell>
                        {d.direction === "IN" ? (
                          <span className="text-money-positive bg-money-positive/10 px-2 py-0.5 rounded text-xs">مقبوضات</span>
                        ) : (
                          <span className="text-money-negative bg-money-negative/10 px-2 py-0.5 rounded text-xs">مدفوعات</span>
                        )}
                      </TableCell>
                      <TableCell>{d.description}</TableCell>
                      <TableCell className="text-left font-semibold tabular-nums" dir="ltr">{fmtAr(d.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function DayCloseReport() {
  const [date, setDate] = useState<string>(todayUtc);
  const [branchId, setBranchId] = useState<number | "">("");
  const [treasuryBreakdown, setTreasuryBreakdown] = useState<Record<number, number>>({});
  const [treasuryCounted, setTreasuryCounted] = useState("0.00");
  const [treasuryNotes, setTreasuryNotes] = useState("");
  const [countRequestId, setCountRequestId] = useState(newClientRequestId);
  const [closeRequestId, setCloseRequestId] = useState(newClientRequestId);
  const [reopenRequestId, setReopenRequestId] = useState(newClientRequestId);
  const [reopenReason, setReopenReason] = useState("");
  const branches = trpc.branches.list.useQuery();
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();

  const q = trpc.reports.dayCloseReconciliation.useQuery({
    date,
    branchId: branchId ? Number(branchId) : undefined,
  });
  const dc: DC | undefined = q.data;
  // الراوتر يفرض فرع المدير حتى لو ترك محدّد «كل الفروع» فارغاً. اعتمد النطاق
  // الموثّق في نتيجة الخادم للعنوان والجرد، لا قيمة المحدّد غير الموثوقة.
  const effectiveBranchId: number | "" = branchId === "" ? dc?.branchId ?? "" : branchId;
  const dailyQ = trpc.treasury.dailyCashReconciliation.useQuery(
    { branchId: Number(effectiveBranchId || 0), businessDate: date },
    { enabled: effectiveBranchId !== "" },
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
    setReopenRequestId(newClientRequestId());
    setReopenReason("");
  }, [effectiveBranchId, date]);
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
      setReopenRequestId(newClientRequestId());
      setReopenReason("");
      void utils.treasury.dailyCashReconciliation.invalidate();
    },
    onError: (error) => notify.err(error),
  });

  const branchLabel = effectiveBranchId
    ? branches.data?.find((b) => b.id === effectiveBranchId)?.name ?? String(effectiveBranchId)
    : "كل الفروع";

  const driftTone = (drift: string | null): "positive" | "negative" | "warning" | "default" => {
    if (drift == null) return "default";
    const n = Number(drift);
    if (n === 0) return "positive";
    return n > 0 ? "warning" : "negative";
  };

  const daily = dailyQ.data;
  const saved = daily?.reconciliation;
  const position = dc?.cashPosition;
  const reconciliationStale = daily?.blockers.some((blocker) => blocker.code === "STALE_EVIDENCE") ?? false;
  const finalCountUsable = Boolean(position?.isReadyForFinalCount && !reconciliationStale && saved?.status !== "REOPENED" && saved?.countedTreasuryCash != null);
  const finalVariance = finalCountUsable && position && saved
    ? D(saved.countedTreasuryCash).minus(position.expectedCashOnHand).toFixed(2)
    : null;
  const kpis: KpiItem[] = dc
    ? position
      ? [
          { label: "الرقم النهائي المتوقع", value: fmtAr(position.expectedCashOnHand), tone: "info", hint: "الخزينة + الأدراج المفتوحة + النقد بالطريق" },
          { label: "المعدود الفعلي النهائي", value: finalCountUsable ? fmtAr(saved!.countedTreasuryCash) : "—", tone: "default", hint: finalCountUsable ? "جرد الخزينة بعد تصفية المواقع الوسيطة" : "لا يصبح نهائياً قبل إغلاق الورديات والعهد" },
          { label: "فرق المطابقة النهائي", value: finalVariance == null ? "—" : fmtAr(finalVariance), tone: driftTone(finalVariance), hint: finalVariance == null ? "بانتظار استيفاء شروط الإقفال" : D(finalVariance).isZero() ? "مطابقة تامة" : "فائض أو عجز يحتاج معالجة" },
          { label: "رصيد الخزينة المتوقع", value: fmtAr(position.expectedTreasuryCash), tone: "default", hint: "الرصيد التراكمي المثبت في دفتر الخزينة" },
          { label: "نقد خارج الخزينة", value: fmtAr(D(position.expectedDrawersCash).plus(position.cashInTransit).toString()), tone: "default", hint: "نقد في الأدراج + عهد نقدية بالطريق" },
        ]
      : [
          { label: "المتوقَّع في الورديات", value: fmtAr(dc.totals.shiftExpected), tone: "info", hint: "حركة الوردية وليست رصيد الخزينة النهائي" },
          { label: "المعدود عند الإغلاق", value: fmtAr(dc.totals.counted), tone: "default", hint: `${dc.totals.closedCount} وردية مغلقة` },
          { label: "فرق الورديات", value: fmtAr(dc.totals.drift), tone: driftTone(dc.totals.drift), hint: "التقرير النهائي محجوب حتى اكتمال الأدلة" },
        ]
    : [];
  const dailyPanel = effectiveBranchId === "" ? (
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
                branchId: Number(effectiveBranchId),
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
            <p className="text-xs text-muted-foreground">الإقفال يحتاج مستخدماً مختلفاً عن منفّذ الجرد، بلا استثناء للدور.</p>
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
            <Button
              variant="outline"
              disabled={reopenDailyM.isPending || reopenReason.trim().length < 10 || !reopenRequestId}
              onClick={() => reopenDailyM.mutate({
                reconciliationId: Number(saved.id),
                expectedVersion: Number(saved.version),
                reason: reopenReason.trim(),
                clientRequestId: reopenRequestId,
              })}
              className="gap-1.5"
            >
              <RotateCcw className="size-4" /> إعادة فتح المطابقة
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const missedDailyPanel = effectiveBranchId === "" ? null : (
    <MissedDailyCountExceptionPanel
      branchId={Number(effectiveBranchId)}
      businessDate={date}
      canManage={canManageDaily}
    />
  );

  function onExport() {
    if (!dc || dc.withheldBlindCountShiftCount > 0) {
      if (dc?.withheldBlindCountShiftCount) {
        notify.warn("التقرير جزئي", "أكمل العدّ المستقل للعهد النقدية قبل تصدير تقرير الإقفال.");
      }
      return;
    }
    const exportRowsData = dc.shifts.map((r) => ({
      shiftId: `#${r.shiftId}`,
      branchName: r.branchName ?? "",
      userName: r.userName ?? "",
      shiftType: shiftTypeLabel(r.shiftType),
      status: r.status === "CLOSED" ? "مغلقة" : "مفتوحة",
      opening: Number(r.opening),
      salesCash: Number(r.salesCash),
      collectionsCash: Number(r.collectionsCash),
      otherIn: Number(r.otherIn),
      cashIn: Number(r.cashIn),
      returnsCash: Number(r.returnsCash),
      expensesCash: Number(r.expensesCash),
      otherOut: Number(r.otherOut),
      cashDrops: Number(r.cashDrops),
      operatingOut: Number(r.operatingOut),
      expected: Number(r.expected),
      counted: r.counted == null ? "" : Number(r.counted),
      drift: r.drift == null ? "" : Number(r.drift),
      handoversCash: Number(r.handoversCash),
      retainedInDrawer: r.retainedInDrawer == null ? "" : Number(r.retainedInDrawer),
    }));

    if (dc.directOperations.receiptCount > 0) {
      exportRowsData.push({
        shiftId: "مباشر",
        branchName: branchLabel,
        userName: "الخزينة المباشرة (خارج الأدراج)",
        shiftType: "مباشر",
        status: "مكتملة",
        opening: 0,
        salesCash: Number(dc.directOperations.salesCash),
        collectionsCash: Number(dc.directOperations.collectionsCash),
        otherIn: Number(dc.directOperations.otherIn),
        cashIn: Number(dc.directOperations.cashIn),
        returnsCash: Number(dc.directOperations.returnsCash),
        expensesCash: Number(dc.directOperations.expensesCash),
        otherOut: Number(dc.directOperations.otherOut),
        cashDrops: 0,
        operatingOut: Number(dc.directOperations.operatingOut),
        expected: Number(dc.directOperations.netCash),
        counted: "",
        drift: "",
        handoversCash: 0,
        retainedInDrawer: "",
      });
    }

    if (dc.cashPosition) {
      exportRowsData.push({
        shiftId: "نهائي",
        branchName: branchLabel,
        userName: dc.cashPosition.branchCount > 1 ? "الموقف النقدي النهائي لكل الفروع" : "الموقف النقدي النهائي للفرع",
        shiftType: "مطابقة نهائية",
        status: dc.cashPosition.isReadyForFinalCount ? "جاهزة للجرد النهائي" : "غير جاهزة للإقفال",
        opening: 0,
        salesCash: 0,
        collectionsCash: 0,
        otherIn: 0,
        cashIn: 0,
        returnsCash: 0,
        expensesCash: 0,
        otherOut: 0,
        cashDrops: 0,
        operatingOut: 0,
        expected: Number(dc.cashPosition.expectedCashOnHand),
        counted: finalCountUsable ? Number(saved!.countedTreasuryCash) : "",
        drift: finalCountUsable ? Number(finalVariance) : "",
        handoversCash: 0,
        retainedInDrawer: "",
      });
    }

    exportRows(exportRowsData, {
      filename: `مطابقة-إقفال-اليوم-${date}-${effectiveBranchId || "الكل"}`,
      columns: [
        { key: "shiftId", header: "الوردية", map: (r) => r.shiftId },
        { key: "branchName", header: "الفرع", map: (r) => r.branchName },
        { key: "userName", header: "الكاشير", map: (r) => r.userName },
        { key: "shiftType", header: "النوع", map: (r) => r.shiftType },
        { key: "status", header: "الحالة", map: (r) => r.status },
        { key: "opening", header: "افتتاحي", map: (r) => r.opening },
        { key: "salesCash", header: "مبيعات نقدية", map: (r) => r.salesCash },
        { key: "collectionsCash", header: "تحصيلات", map: (r) => r.collectionsCash },
        { key: "otherIn", header: "مقبوضات أخرى", map: (r) => r.otherIn },
        { key: "cashIn", header: "إجمالي الداخل", map: (r) => r.cashIn },
        { key: "returnsCash", header: "مرتجعات", map: (r) => r.returnsCash },
        { key: "expensesCash", header: "مصروفات/سندات", map: (r) => r.expensesCash },
        { key: "otherOut", header: "مصروفات أخرى", map: (r) => r.otherOut },
        { key: "cashDrops", header: "سحب أثناء الوردية", map: (r) => r.cashDrops },
        { key: "operatingOut", header: "إجمالي الخارج التشغيلي", map: (r) => r.operatingOut },
        { key: "expected", header: "المتوقَّع", map: (r) => r.expected },
        { key: "counted", header: "المعدود", map: (r) => r.counted },
        { key: "drift", header: "الفرق", map: (r) => r.drift },
        { key: "handoversCash", header: "خرج إلى العهدة", map: (r) => r.handoversCash },
        { key: "retainedInDrawer", header: "المتبقّي بالدرج", map: (r) => r.retainedInDrawer },
      ],
    });
  }

  // طباعة A4 — نفس أعمدة الشاشة/التصدير (تفصيل كل وردية)، ولا اقتطاع (اليوم الواحد محدودُ الورديات أصلاً).
  function onPrint() {
    if (!dc || dc.withheldBlindCountShiftCount > 0) {
      if (dc?.withheldBlindCountShiftCount) {
        notify.warn("التقرير جزئي", "أكمل العدّ المستقل للعهد النقدية قبل طباعة تقرير الإقفال.");
      }
      return;
    }
    const printRows = dc.shifts.map((r) => ({
      shiftId: `#${r.shiftId}`,
      branch: r.branchName ?? "—",
      cashier: r.userName ?? "—",
      status: r.status === "CLOSED" ? "مغلقة" : "مفتوحة",
      expected: fmtAr(r.expected),
      counted: r.counted == null ? "—" : fmtAr(r.counted),
      drift: r.drift == null ? "—" : fmtAr(r.drift),
      handovers: fmtAr(r.handoversCash),
    }));

    if (dc.directOperations.receiptCount > 0) {
      printRows.push({
        shiftId: "مباشر",
        branch: branchLabel,
        cashier: "الخزينة المباشرة (خارج الأدراج)",
        status: "مكتملة",
        expected: fmtAr(dc.totals.directNetCash),
        counted: "—",
        drift: "—",
        handovers: "—",
      });
    }

    if (dc.cashPosition) {
      printRows.push({
        shiftId: "نهائي",
        branch: branchLabel,
        cashier: dc.cashPosition.branchCount > 1 ? "الموقف النقدي النهائي لكل الفروع" : "الموقف النقدي النهائي للفرع",
        status: dc.cashPosition.isReadyForFinalCount ? "جاهزة للجرد النهائي" : "غير جاهزة للإقفال",
        expected: fmtAr(dc.cashPosition.expectedCashOnHand),
        counted: finalCountUsable ? fmtAr(saved!.countedTreasuryCash) : "—",
        drift: finalCountUsable ? fmtAr(finalVariance!) : "—",
        handovers: "—",
      });
    }

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
      rows: printRows,
      summary: [
        ...(dc.cashPosition
          ? [
              { label: "رصيد الخزينة المتوقع", value: formatIqd(dc.cashPosition.expectedTreasuryCash) },
              { label: "النقد الموجود في الأدراج", value: formatIqd(dc.cashPosition.expectedDrawersCash) },
              { label: "النقد بالعهدة في الطريق", value: formatIqd(dc.cashPosition.cashInTransit) },
              { label: "الرقم النهائي المتوقع", value: formatIqd(dc.cashPosition.expectedCashOnHand), large: true, bold: true },
            ]
          : []),
        ...(dc.directOperations.receiptCount > 0
          ? [
              { label: "صافي المقبوضات المباشرة (الخزينة)", value: formatIqd(dc.totals.directNetCash), bold: true },
              { label: "محصلة حركة اليوم (ليست الرصيد النهائي)", value: formatIqd(dc.totals.expected), bold: true },
            ]
          : []),
        { label: "معدود الورديات عند إغلاقها", value: formatIqd(dc.totals.counted) },
        { label: "فرق الورديات", value: formatIqd(dc.totals.drift), bold: true },
      ],
    });
    if (!opened) notify.warn("حجب نافذة الطباعة", "اسمح بالنوافذ المنبثقة ثم أعد المحاولة.");
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
      exportDisabled={!dc || (!dc.cashPosition && dc.shifts.length === 0 && dc.directOperations.receiptCount === 0) || dc.withheldBlindCountShiftCount > 0}
      printDisabled={!dc || (!dc.cashPosition && dc.shifts.length === 0 && dc.directOperations.receiptCount === 0) || dc.withheldBlindCountShiftCount > 0}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">تاريخ اليوم</label>
            <Input
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
            <AppSelect
              className="h-9"
              value={String(effectiveBranchId)}
              onValueChange={(next) => setBranchId(next ? Number(next) : "")}
            >
              <option value="">كل الفروع</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </AppSelect>
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
      ) : dc.shifts.length === 0 && dc.directOperations.receiptCount === 0 ? (
        <div className="space-y-4">
          <PartialBlindCountWarning count={dc.withheldBlindCountShiftCount} />
          {dc.cashPosition && <ReconciliationHero dc={dc} daily={daily} />}
          {dailyPanel}
          {missedDailyPanel}
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              لا ورديات أو مقبوضات نقدية في {fmtDate(date)} لـ{branchLabel}.
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          <PartialBlindCountWarning count={dc.withheldBlindCountShiftCount} />
          <ReconciliationHero dc={dc} daily={daily} />
          {dailyPanel}
          {missedDailyPanel}
          {dc.directOperations.receiptCount > 0 && (
            <DirectOperationsPanel direct={dc.directOperations} />
          )}
          {dc.directMovements && dc.directMovements.count > 0 && (
            <DirectMovementsCard dm={dc.directMovements} />
          )}
          {dc.shifts.length > 0 ? (
            <ShiftTable dc={dc} />
          ) : (
            <Card>
              <CardContent className="p-6 text-center text-xs text-muted-foreground">
                لا توجد ورديات مغلقة في هذا اليوم. يمكنك العودة لتقارير سابقة أو مراجعة الحركات المباشرة.
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </ReportShell>
  );
}

function PartialBlindCountWarning({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Card className="border-[var(--sem-warn)]/50">
      <CardContent className="flex items-start gap-2 p-4 text-sm">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]" />
        <div>
          <p className="font-bold">تقرير جزئي: حُجبت {count} وردية حتى اكتمال العدّ المستقل للعهدة</p>
          <p className="mt-1 text-xs text-muted-foreground">
            الأرقام الإجمالية لا تمثل اليوم كاملاً. التصدير والطباعة معطّلان لمنع تداول تقرير مالي ناقص.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function CashPositionBox({
  label,
  value,
  emphasized = false,
  negative = false,
}: {
  label: string;
  value: string | null;
  emphasized?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`flex min-h-16 flex-col justify-center rounded border px-3 py-2 text-center ${emphasized ? "border-money-positive/40 bg-money-positive/5" : negative ? "border-money-negative/40 bg-money-negative/5" : "bg-muted/10"}`}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <strong className={`mt-1 tabular-nums ${emphasized ? "text-money-positive" : negative ? "text-money-negative" : "text-foreground"}`} dir="ltr">
        {value == null ? "—" : `${fmtAr(value)} د.ع`}
      </strong>
    </div>
  );
}

function CashEquationSign({ children }: { children: string }) {
  return <span className="self-center text-center text-lg font-bold text-muted-foreground" aria-hidden>{children}</span>;
}

/** لوحة «المتوقَّع مقابل المعدود مقابل الفرق» — بلونٍ دلاليّ واضح على مجموع اليوم. */
function ReconciliationHero({ dc, daily }: { dc: DC; daily?: RouterOutputs["treasury"]["dailyCashReconciliation"] }) {
  const drift = Number(dc.totals.drift);
  const balanced = dc.driftCount === 0 && dc.totals.counted !== "0.00";
  const driftCls = drift === 0 ? "text-money-positive" : drift > 0 ? "text-stock-low" : "text-money-negative";
  const driftLabel = drift === 0 ? "مطابق" : drift > 0 ? "فائض" : "عجز";
  const hasOpen = dc.totals.openCount > 0;
  const saved = daily?.reconciliation;
  const hasDirect = (dc.directOperations?.receiptCount ?? 0) > 0;
  const position = dc.cashPosition;
  const reconciliationStale = daily?.blockers.some((blocker) => blocker.code === "STALE_EVIDENCE") ?? false;
  const finalCountUsable = Boolean(position?.isReadyForFinalCount && !reconciliationStale && saved?.status !== "REOPENED" && saved?.countedTreasuryCash != null);
  const finalVariance = finalCountUsable && position && saved
    ? D(saved.countedTreasuryCash).minus(position.expectedCashOnHand).toFixed(2)
    : null;
  const finalMatched = finalVariance != null && D(finalVariance).isZero();
  const reconciliationBorderClass = finalVariance != null
    ? finalMatched
      ? "border-money-positive/40"
      : "border-money-negative/40"
    : balanced
      ? "border-money-positive/40"
      : dc.driftCount > 0
        ? "border-money-negative/40"
        : undefined;
  const positionTitle = position?.branchCount === 1
    ? "الموقف النقدي النهائي للفرع"
    : `الموقف النقدي النهائي لكل الفروع (${position?.branchCount ?? 0})`;

  return (
    <Card className={reconciliationBorderClass}>
      <CardContent className="p-4 space-y-3">
        {position && (
          <section className="space-y-3 rounded-md border bg-card p-3" aria-label={positionTitle}>
            <div className="flex flex-wrap items-start justify-between gap-2 border-b pb-2">
              <div>
                <h2 className="text-sm font-bold">{positionTitle}</h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">هذا هو الرقم الوحيد الذي يُقارن بالجرد النهائي؛ الأرقام أدناه لا تُجمع عليه مرة أخرى.</p>
              </div>
              <span className={`rounded border px-2 py-1 text-[11px] font-bold ${position.isReadyForFinalCount ? "border-money-positive/40 text-money-positive" : "border-[var(--sem-warn)]/50 text-[var(--sem-warn)]"}`}>
                {position.isReadyForFinalCount ? "مواقع النقد جاهزة للجرد" : "غير جاهز للإقفال النهائي"}
              </span>
            </div>

            <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1.2fr]">
              <CashPositionBox label="رصيد الخزينة التراكمي" value={position.expectedTreasuryCash} />
              <CashEquationSign>+</CashEquationSign>
              <CashPositionBox label="النقد في الأدراج" value={position.expectedDrawersCash} />
              <CashEquationSign>+</CashEquationSign>
              <CashPositionBox label="النقد بالطريق" value={position.cashInTransit} />
              <CashEquationSign>=</CashEquationSign>
              <CashPositionBox label="الرقم النهائي المتوقع" value={position.expectedCashOnHand} emphasized />
            </div>

            <div className="grid grid-cols-1 gap-2 border-t pt-3 sm:grid-cols-3">
              <CashPositionBox label="الرقم النهائي المتوقع" value={position.expectedCashOnHand} />
              <CashPositionBox label="النقد المعدود فعلياً" value={finalCountUsable ? saved!.countedTreasuryCash : null} />
              <CashPositionBox label="فرق المطابقة النهائي" value={finalVariance} emphasized={finalMatched} negative={finalVariance != null && !finalMatched} />
            </div>

            <p className="text-[11px] text-muted-foreground">
              {position.isReadyForFinalCount
                ? reconciliationStale
                  ? "تغيّرت الحركات بعد آخر جرد؛ أعد عدّ الخزينة قبل اعتماد المطابقة النهائية."
                  : "كل الورديات والعهد الوسيطة مصفّاة؛ يمكن اعتماد مقارنة الجرد النهائي الآن."
                : "يلزم إغلاق كل الورديات وتصفية النقد المتبقي في الأدراج وتسوية العهد بالطريق قبل اعتماد الجرد النهائي."}
            </p>
          </section>
        )}

        {/* الورديات المغلقة: معادلة المطابقة الصريحة الدقيقة */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-muted-foreground">
              {hasOpen ? "مطابقة الورديات المغلقة (المكتملة)" : "مطابقة نقد الأدراج"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {dc.totals.closedCount} وردية مغلقة من أصل {dc.totals.shiftCount}
            </span>
          </div>
          <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] rounded-lg bg-muted/20 p-3">
            {/* المتوقَّع المغلق */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground">المتوقَّع بالدفتر (الورديات المغلقة)</p>
              <p className="text-2xl font-bold tabular-nums text-[var(--sem-info)]" dir="ltr">
                {fmtAr(dc.totals.closedExpected)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">الافتتاحي + المقبوضات − المصروفات</p>
            </div>
            <div className="hidden text-muted-foreground sm:block" aria-hidden>
              <ArrowLeftRight className="size-5" />
            </div>
            {/* المعدود */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground">المعدود عند الإغلاق</p>
              <p className="text-2xl font-bold tabular-nums" dir="ltr">{fmtAr(dc.totals.counted)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">النقد الفعلي المسلّم من الكاشير</p>
            </div>
            <div className="hidden text-muted-foreground sm:block" aria-hidden>=</div>
            {/* الفرق */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground">فرق المطابقة</p>
              <p className={`inline-flex items-center justify-center gap-1 text-2xl font-bold tabular-nums ${driftCls}`} dir="ltr">
                {drift === 0 ? (
                  <CheckCircle2 aria-hidden className="size-5" />
                ) : (
                  <AlertTriangle aria-hidden className="size-5" />
                )}
                {fmtAr(dc.totals.drift)}
              </p>
              <p className={`mt-0.5 text-[11px] font-bold ${driftCls}`}>{driftLabel}</p>
            </div>
          </div>
        </div>

        {/* التدفقات النقدية المباشرة خارج الأدراج إن وُجدت */}
        {hasDirect && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <Wallet className="size-4 text-primary" />
              <span>
                يوجد <strong>{dc.directOperations.receiptCount}</strong> حركة نقدية مباشرة (خارج الأدراج) بصافي:{" "}
                <strong className="text-primary tabular-nums" dir="ltr">{fmtAr(dc.totals.directNetCash)} د.ع</strong>
              </span>
            </div>
            <div className="text-foreground">
              محصلة حركة اليوم (ليست الرصيد النهائي):{" "}
              <strong className="text-money-positive tabular-nums text-sm font-bold" dir="ltr">
                {fmtAr(dc.totals.expected)} د.ع
              </strong>
            </div>
          </div>
        )}

        {/* الورديات المفتوحة إن وجدت */}
        {hasOpen && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-primary" />
              <span>
                يوجد <strong>{dc.totals.openCount}</strong> وردية جارية لم تُغلق بعد — النقد الموجود الآن في الأدراج المفتوحة:{" "}
                <strong className="tabular-nums" dir="ltr">{fmtAr(dc.totals.openRunningExpected)} د.ع</strong>
              </span>
            </div>
            <div className="text-foreground">
              إجمالي النقد الموجود الآن في الأدراج:{" "}
              <strong className="text-money-positive tabular-nums text-sm font-bold" dir="ltr">
                {fmtAr(dc.totals.physicalDrawerCash)} د.ع
              </strong>
            </div>
          </div>
        )}

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

/**
 * أعمدة تفصيل الورديات + ذيل الإجماليات.
 * ⚠️ «الإجمالي (…)» كان `colSpan={2}`؛ الذيلُ لكل عمود فالتسمية على العمود الأوّل.
 */
function useShiftColumns(dc: DC) {
  return useMemo<ColumnDef<DC["shifts"][number], unknown>[]>(() => [
    {
      id: "shift", header: "الوردية",
      accessorFn: (sh) => sh.shiftId,
      cell: ({ row }) => {
        const sh = row.original;
        return (
          <div>
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
          </div>
        );
      },
      footer: () => `الإجمالي (${dc.totals.shiftCount} وردية · ${dc.balancedCount} مطابقة · ${dc.driftCount} بفرق)`,
      meta: { kind: "text", wrap: true },
    },
    { id: "user", header: "الكاشير", accessorFn: (sh) => sh.userName ?? "—", meta: { kind: "actor" } },
    {
      id: "opening", header: "افتتاحي", accessorFn: (sh) => Number(sh.opening),
      cell: ({ row }) => (
        <DayCloseCellDetailsHover shift={row.original} field="opening">
          <span className="tabular-nums cursor-help border-b border-dotted border-muted-foreground/30 hover:border-foreground transition-colors">
            {fmtAr(row.original.opening)}
          </span>
        </DayCloseCellDetailsHover>
      ),
      footer: () => fmtAr(dc.totals.opening), meta: { kind: "money" },
    },
    {
      id: "cashIn", header: "داخل نقدي", accessorFn: (sh) => Number(sh.cashIn),
      cell: ({ row }) => (
        <DayCloseCellDetailsHover shift={row.original} field="cashIn">
          <span className="text-money-positive font-semibold tabular-nums cursor-help border-b border-dotted border-[var(--sem-pos)]/40 hover:border-[var(--sem-pos)] transition-colors">
            {fmtAr(row.original.cashIn)}
          </span>
        </DayCloseCellDetailsHover>
      ),
      footer: () => <span className="text-money-positive">{fmtAr(dc.totals.cashIn)}</span>, meta: { kind: "money" },
    },
    {
      id: "operatingOut", header: "خارج تشغيلي", accessorFn: (sh) => Number(sh.operatingOut),
      cell: ({ row }) => (
        <DayCloseCellDetailsHover shift={row.original} field="operatingOut">
          <span className="text-money-negative font-semibold tabular-nums cursor-help border-b border-dotted border-destructive/40 hover:border-destructive transition-colors">
            {fmtAr(row.original.operatingOut)}
          </span>
        </DayCloseCellDetailsHover>
      ),
      footer: () => <span className="text-money-negative">{fmtAr(dc.totals.operatingOut)}</span>, meta: { kind: "money" },
    },
    {
      id: "expected", header: "المتوقَّع", accessorFn: (sh) => Number(sh.expected),
      cell: ({ row }) => (
        <DayCloseCellDetailsHover shift={row.original} field="expected">
          <span className="font-semibold text-[var(--sem-info)] tabular-nums cursor-help border-b border-dotted border-[var(--sem-info)]/40 hover:border-[var(--sem-info)] transition-colors">
            {fmtAr(row.original.expected)}
          </span>
        </DayCloseCellDetailsHover>
      ),
      footer: () => (
        <span className="text-[var(--sem-info)]" title={dc.totals.openCount > 0 ? `المغلقة: ${fmtAr(dc.totals.closedExpected)} · الجارية: ${fmtAr(dc.totals.openRunningExpected)}` : undefined}>
          {fmtAr(dc.totals.expected)}
        </span>
      ),
      meta: { kind: "money" },
    },
    {
      id: "counted", header: "المعدود", accessorFn: (sh) => (sh.counted == null ? -1 : Number(sh.counted)),
      cell: ({ row }) => (
        <DayCloseCellDetailsHover shift={row.original} field="counted">
          {row.original.counted == null ? (
            <span className="text-xs text-muted-foreground cursor-help border-b border-dotted border-muted-foreground/30">جارية (لم تُغلق)</span>
          ) : (
            <span className="font-semibold tabular-nums cursor-help border-b border-dotted border-muted-foreground/30 hover:border-foreground transition-colors">
              {fmtAr(row.original.counted)}
            </span>
          )}
        </DayCloseCellDetailsHover>
      ),
      footer: () => <span title="المغلقة فقط">{fmtAr(dc.totals.counted)}</span>, meta: { kind: "money" },
    },
    {
      id: "drift", header: "الفرق", accessorFn: (sh) => (sh.drift == null ? 0 : Number(sh.drift)),
      cell: ({ row }) => {
        const sh = row.original;
        const drift = sh.drift == null ? null : Number(sh.drift);
        const cls = drift == null ? "text-muted-foreground" : drift === 0 ? "text-money-positive" : drift > 0 ? "text-stock-low" : "text-money-negative";
        return (
          <DayCloseCellDetailsHover shift={sh} field="drift">
            {sh.drift == null ? (
              <span className="text-[11px] text-muted-foreground cursor-help">—</span>
            ) : (
              <span className={`inline-flex items-center justify-end gap-1 font-semibold tabular-nums cursor-help border-b border-dotted border-current/30 hover:border-current transition-colors ${cls}`}>
                {drift === 0 ? <CheckCircle2 aria-hidden className="size-3.5" /> : <AlertTriangle aria-hidden className="size-3.5" />}
                {fmtAr(sh.drift)}
              </span>
            )}
          </DayCloseCellDetailsHover>
        );
      },
      footer: () => {
        const t = Number(dc.totals.drift);
        const cls = t === 0 ? "text-money-positive" : t > 0 ? "text-stock-low" : "text-money-negative";
        return <span className={cls}>{fmtAr(dc.totals.drift)}</span>;
      },
      meta: { kind: "money" },
    },
    {
      id: "handoversCash", header: "خرج إلى العهدة", accessorFn: (sh) => Number(sh.handoversCash),
      cell: ({ row }) => (
        <DayCloseCellDetailsHover shift={row.original} field="handoversCash">
          <span className="text-muted-foreground tabular-nums cursor-help border-b border-dotted border-muted-foreground/30 hover:border-foreground transition-colors">
            {row.original.handoversCash === "0.00" ? "—" : fmtAr(row.original.handoversCash)}
          </span>
        </DayCloseCellDetailsHover>
      ),
      footer: () => <span className="text-muted-foreground">{fmtAr(dc.totals.handoversCash)}</span>, meta: { kind: "money" },
    },
  ], [dc]);
}

/** جدول تفصيل الورديات. */
function ShiftTable({ dc }: { dc: DC }) {
  const shiftColumns = useShiftColumns(dc);
  return (
    <Card>
      <CardContent className="p-0">
        <DataTable
          columns={shiftColumns}
          data={dc.shifts}
          searchable={false}
          emptyText="لا ورديات في هذا اليوم."
        />
        {dc.totals.openCount > 0 && (
          <div className="border-t bg-muted/10 p-3 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
            <span>
              يوجد <strong className="text-foreground">{dc.totals.openCount}</strong> وردية جارية مفتوحة برصيد متوقع:{" "}
              <strong className="text-foreground tabular-nums" dir="ltr">{fmtAr(dc.totals.openRunningExpected)} د.ع</strong> لم تُعد بعد.
            </span>
            <span>
              النقد الموجود الآن بالأدراج (المفتوحة + المتبقّي من المغلقة):{" "}
              <strong className="text-money-positive tabular-nums" dir="ltr">{fmtAr(dc.totals.physicalDrawerCash)} د.ع</strong>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
