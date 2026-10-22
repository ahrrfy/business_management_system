import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
/* ============================================================================
 * كشف حضور الموظف — بطاقة في صفحته (client/src/components/hr/EmployeeStatementCard.tsx)
 *
 * قرار المالك (٣١/٧): «أريد لكل يوم ساعاته من ساعة إلى ساعة وأجر الساعة لهذا اليوم»،
 * و«المجموع التراكميّ لأيام الشهر هو الراتب الذي يستحقّه».
 *
 * تعرض صفّاً لكل يوم دوام، وتسمح بتصحيح الأوقات مباشرةً للأيام الموسومة «يحتاج مراجعة»
 * (بصمةُ خروجٍ ناقصة أو ساعاتٌ تجاوزت سقف المعقولية) مع دعم الدوام المجزّأ (فترتين أو أكثر)
 * والاستراحات/الزمنيات — والتصحيح اليدويّ لا يطمسه الطيّ التلقائي لاحقاً.
 * وتُطبَع A4 وتُصدَّر Excel وتُشارَك على واتساب.
 * ========================================================================== */
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { exportRows } from "@/lib/export";
import { iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { printAttendanceStatement } from "@/lib/printing/printAttendanceStatement";
import { trpc } from "@/lib/trpc";
import { whatsappLink } from "@/lib/intlPhone";
import {
  attendanceHoursViolation,
  buildDefaultSplitSessions,
  computeSessionsSummary,
  formatDurationArabic,
  parseAttendanceDayDetails,
  parseManualAttendanceEdit,
  spanHours,
  suggestNextSplitSession,
} from "@shared/attendanceHours";
import {
  CalendarDays,
  Clock,
  Coffee,
  FileSpreadsheet,
  Info,
  Lock,
  PenLine,
  Plus,
  Printer,
  RefreshCw,
  Send,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATE_LABEL: Record<string, string> = {
  present: "حضور",
  absent: "غياب",
  open: "بصمة انصراف ناقصة",
  paidLeave: "إجازة مدفوعة",
  unpaidLeave: "إجازة بلا راتب",
  beforeStart: "قبل المباشرة",
  restWorked: "عمل يوم عطلة",
};

type DayStatus = "PRESENT" | "LATE" | "ABSENT" | "LEAVE";
type ShiftEditRow = { checkIn: string; checkOut: string; crossMidnight?: boolean };

/** آخر ١٢ شهراً كخيارات. */
function recentMonths(count = 12): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

/** اليوم التالي بصيغة YYYY-MM-DD (لأوقات الانصراف بعد منتصف الليل). */
function nextDateStr(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const BREAK_PRESETS = [
  { label: "بلا استراحة", mins: "" },
  { label: "30 د", mins: "30" },
  { label: "60 د (ساعة)", mins: "60" },
  { label: "90 د (ساعة ونصف)", mins: "90" },
  { label: "120 د (ساعتان)", mins: "120" },
  { label: "180 د (3 س)", mins: "180" },
];

export function EmployeeStatementCard({ employeeId, phone }: { employeeId: number; phone?: string | null }) {
  const { can } = useCatalogPeopleOperationAccess();
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [fix, setFix] = useState<{
    date: string;
    shiftMode: "single" | "split";
    sessions: ShiftEditRow[];
    breakMinutes: string;
    checkIn: string;
    checkOut: string;
    hours: string;
    crossMidnight: boolean;
    status: DayStatus;
    lateDeductionMinutes: string;
    notes: string;
  } | null>(null);

  /*
   * تغيير أيّ من الوقتين أو مدّة الاستراحة/الزمنية يُعيد اشتقاق صافي الساعات فوراً.
   * الاشتقاق التلقائي يمنع السهو، والخادم يمنع الالتفاف.
   */
  const setFixTime = (patch: { checkIn?: string; checkOut?: string; crossMidnight?: boolean; breakMinutes?: string }) =>
    setFix((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch };
      const inferredCross =
        patch.crossMidnight !== undefined
          ? patch.crossMidnight
          : Boolean(next.checkIn && next.checkOut && next.checkOut <= next.checkIn);
      next.crossMidnight = inferredCross;
      if (next.status === "ABSENT" || next.status === "LEAVE") {
        return { ...next, hours: "0" };
      }
      const auto = spanHours(next.checkIn, next.checkOut, { crossMidnight: inferredCross });
      if (auto == null) return next;
      const breakMins = Math.max(0, Number(next.breakMinutes) || 0);
      const netHours = Math.max(0, Math.round((auto - breakMins / 60) * 100) / 100);
      return { ...next, hours: netHours.toFixed(2) };
    });

  const updateSplitSessions = (nextSessions: ShiftEditRow[]) =>
    setFix((cur) => {
      if (!cur) return cur;
      const summary = computeSessionsSummary(nextSessions);
      const nextCheckIn = summary.firstCheckIn ?? cur.checkIn;
      const nextCheckOut = summary.lastCheckOut ?? "";
      return {
        ...cur,
        sessions: nextSessions,
        checkIn: nextCheckIn,
        checkOut: nextCheckOut,
        crossMidnight: summary.lastCrossMidnight,
        breakMinutes: summary.breakMinutes > 0 ? String(summary.breakMinutes) : "",
        hours:
          cur.status === "ABSENT" || cur.status === "LEAVE"
            ? "0"
            : summary.totalHours > 0
              ? summary.totalHoursStr
              : cur.hours,
      };
    });

  const splitSummary = useMemo(
    () => (fix && fix.shiftMode === "split" ? computeSessionsSummary(fix.sessions) : null),
    [fix],
  );

  const fixSpan = fix ? spanHours(fix.checkIn, fix.checkOut, { crossMidnight: fix.crossMidnight }) : null;
  const fixSingleNetSpan =
    fixSpan != null && fix
      ? Math.max(0, Math.round((fixSpan - (Math.max(0, Number(fix.breakMinutes) || 0) / 60)) * 100) / 100)
      : null;
  const isPaidFixStatus = fix ? fix.status === "PRESENT" || fix.status === "LATE" : true;
  /** مرآة حارس الخادم بالنواة نفسها — تمنع رحلةً بلا طائل وتشرح السبب مكان وقوعه. */
  const fixError = fix
    ? (isPaidFixStatus && fix.shiftMode === "split" && splitSummary?.violation) ||
      attendanceHoursViolation({
        checkIn: fix.checkIn,
        checkOut: fix.checkOut,
        hours: Number(fix.hours),
        isPaidStatus: isPaidFixStatus,
        crossMidnight: fix.crossMidnight,
        breakMinutes: fix.shiftMode === "single" ? Number(fix.breakMinutes) || 0 : splitSummary?.breakMinutes,
        sessions: fix.shiftMode === "split" ? fix.sessions : undefined,
      })
    : null;

  const q = trpc.attendance.employeeStatement.useQuery({ employeeId, period }, { enabled: can("attendance.employeeStatement") });
  const d = q.data;

  const correct = trpc.attendance.record.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظ التصحيح اليدوي لليوم — رُفع وسم المراجعة");
      setFix(null);
      await Promise.all([
        utils.attendance.employeeStatement.invalidate({ employeeId, period }),
        utils.attendance.list.invalidate(),
        utils.attendance.summary.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e),
  });

  const autoHealedKeyRef = useRef<string | null>(null);
  const manualRecomputeRef = useRef(false);
  const recompute = trpc.attendance.recomputeRates.useMutation({
    onSuccess: async (res) => {
      const totalChanged = (res.updated ?? 0) + (res.refoldedDays ?? 0) + (res.cleanedGhostDays ?? 0);
      if (manualRecomputeRef.current || totalChanged > 0) {
        notify.ok(
          totalChanged > 0
            ? `تمّت مزامنة البصمات وإعادة احتساب الشهر (${totalChanged} يوم محدَّث)`
            : "تمّ التحقّق والمزامنة — جميع الساعات والأجور محدَّثة ومطابقة",
        );
      }
      manualRecomputeRef.current = false;
      await Promise.all([
        utils.attendance.employeeStatement.invalidate({ employeeId, period }),
        utils.attendance.list.invalidate(),
        utils.attendance.summary.invalidate(),
      ]);
    },
    onError: (e) => {
      if (manualRecomputeRef.current) notify.err(e);
      manualRecomputeRef.current = false;
    },
  });

  useEffect(() => {
    const key = `${employeeId}:${period}`;
    if (d?.needsHealing && !d?.payrollSnapshot && can("attendance.recomputeRates") && autoHealedKeyRef.current !== key) {
      autoHealedKeyRef.current = key;
      manualRecomputeRef.current = false;
      recompute.mutate({ period, employeeId });
    }
  }, [d?.needsHealing, d?.payrollSnapshot, employeeId, period, can]);

  /*
   * المستحقّ من الخادم بأساسه (`amountDue`/`dueBasis`) لا من حساب الحضور دائماً: المُعفى
   * بلا بصمات كان يرى — ويُشارك ويطبع — صفراً تحت سطرٍ يقول إن الحضور لا يؤثّر في راتبه.
   */
  const totalDue = useMemo(() => (d ? Number(d.amountDue) : 0), [d]);
  /** لقطةُ الشهر المصروف — وجودُها يعني أن الرقم أعلاه مجمَّدٌ من المسيّر لا مشتقٌّ اليوم (ق٣). */
  const snap = d?.payrollSnapshot ?? null;
  const dueLabel = snap
    ? `الأجر المستحقّ عن الشهر (من مسيّر ${snap.status === "paid" ? "مدفوع" : "معتمد"})`
    : d?.dueBasis === "exempt"
      ? "الراتب الثابت المستحقّ (لا يخضع للحضور)"
      : d?.dueBasis === "fixedSalary"
        ? "الراتب الثابت المستحقّ (الأجر بالحضور غير مفعَّل)"
        : d?.dueBasis === "hourly"
          ? "الأجر المستحقّ عن الشهر (أجرٌ بالساعة من سجلّ الحضور)"
          : "صافي الأجر المستحقّ عن الشهر (أجر الدوام + الإضافي)";

  if (q.isLoading) return <Card><CardContent className="p-6 text-center text-muted-foreground">جارٍ تحميل الكشف…</CardContent></Card>;
  if (!d) return null;

  const shareText = [
    `كشف حضور ودوام — ${d.employee.name}`,
    `الشهر: ${d.period}`,
    d.dueBasis === "exempt" ? "راتب ثابت — لا يخضع للحضور" : null,
    `الساعات المدفوعة: ${d.totals.payableHours} من أصل ${d.totals.scheduledHours} ساعة مطلوبة`,
    d.totals.absentDays > 0 ? `أيام الغياب: ${d.totals.absentDays} يوم` : null,
    Number(d.totals.overtimeHours) > 0 ? `الساعات الإضافية (أوفر تايم): ${d.totals.overtimeHours} ساعة` : null,
    `الأجر المستحقّ: ${iqd(String(totalDue))} د.ع`,
    // شهرٌ مصروف: الرسالة تذهب للموظف على واتساب، فيلزمها الصافي الذي قبضه لا الإجماليّ وحده.
    snap ? `الصافي المصروف: ${iqd(snap.net)} د.ع (من مسيّر ${snap.status === "paid" ? "مدفوع" : "معتمد"})` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const wa = whatsappLink(phone);

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarDays aria-hidden className="size-4" />
          كشف الحضور والدوام التفصيلي
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="الشهر">
            {recentMonths().map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          {!snap && can("attendance.recomputeRates") && (
            <Button
              variant="outline"
              size="sm"
              disabled={recompute.isPending}
              onClick={() => {
                manualRecomputeRef.current = true;
                recompute.mutate({ period, employeeId });
              }}
              title="مزامنة البصمات الخام وإعادة احتساب الساعات والفترات والأجور تلقائياً مع الحفاظ على التعديلات اليدوية"
            >
              <RefreshCw aria-hidden className={`size-3.5 ${recompute.isPending ? "animate-spin" : ""}`} />
              {recompute.isPending ? "جارٍ المزامنة والاحتساب…" : "مزامنة البصمات وإعادة الاحتساب"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => printAttendanceStatement(
            {
              employeeName: d.employee.name, employeeId: d.employee.id, position: d.employee.position,
              department: d.employee.department, branchName: d.employee.branchName,
              period: d.period, from: d.from, to: d.to, totals: d.totals,
              amountDue: d.amountDue, dueBasis: d.dueBasis, payrollSnapshot: snap,
            },
            d.days as never,
          )}>
            <Printer aria-hidden className="size-3.5" /> طباعة الكشف
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportRows(d.days as any[], {
            filename: `كشف حضور ${d.employee.name} ${d.period}`,
            title: `كشف حضور ودوام — ${d.employee.name}`,
            meta: [
              { label: "الشهر", value: d.period },
              { label: "الفترة", value: `${d.from} ← ${d.to}` },
              { label: "ساعات الدوام المطلوبة", value: d.totals.scheduledHours },
              { label: "الساعات المدفوعة المستحقّة", value: d.totals.payableHours },
              // المستحقّ بأساسه — وإلّا قُرئ مجموعُ عمود «أجر اليوم» (صفرٌ للمُعفى) راتباً.
              { label: dueLabel, value: iqd(String(totalDue)) },
            ],
            columns: [
              { key: "date", header: "التاريخ" },
              { key: "dayName", header: "اليوم" },
              { key: "checkIn", header: "وقت الدخول", map: (r: any) => r.checkIn ?? "" },
              { key: "checkOut", header: "وقت الانصراف", map: (r: any) => r.checkOut ?? "" },
              {
                key: "sessions",
                header: "فترات الدوام / الاستراحة",
                map: (r: any) =>
                  r.sessions && r.sessions.length > 1
                    ? `${r.sessions.map((s: any) => `${s.checkIn}←${s.checkOut ?? "؟"}`).join(" ، ")}${r.breakMinutes > 0 ? ` (استراحة/زمنية ${formatDurationArabic(r.breakMinutes)})` : ""}`
                    : r.breakMinutes > 0
                      ? `استراحة/زمنية ${formatDurationArabic(r.breakMinutes)}`
                      : "",
              },
              { key: "scheduledHours", header: "المطلوب" },
              { key: "countedHours", header: "صافي العمل" },
              { key: "overtimeHours", header: "إضافي" },
              { key: "rate", header: "سعر الساعة", money: true },
              { key: "amount", header: "أجر الدوام", money: true },
              { key: "overtimeAmount", header: "أجر الإضافي", money: true },
              { key: "totalAmount", header: "إجمالي اليوم", money: true },
              { key: "state", header: "الحالة", map: (r: any) => STATE_LABEL[r.state] ?? r.state },
              { key: "needsReview", header: "يحتاج مراجعة", map: (r: any) => (r.needsReview ? "نعم" : "") },
            ],
            totalsRow: {
              amount: Number(d.totals.basePay),
              overtimeHours: Number(d.totals.overtimeHours),
              overtimeAmount: Number(d.totals.overtimePay),
              totalAmount: totalDue,
            },
          })}>
            <FileSpreadsheet aria-hidden className="size-3.5" /> تصدير Excel
          </Button>
          {wa && (
            <Button variant="outline" size="sm" asChild>
              <a href={`${wa}?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">
                <Send aria-hidden className="size-3.5" /> مشاركة واتساب
              </a>
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/*
          * الشهر المصروف (ق٣) — أوّل ما يُقرأ: كلُّ ما تحته تفصيلٌ يشرح كيف حُسِب، لا رقمٌ
          * يُنافس المصروف. ونُظهر الاشتقاق الحيّ **عند اختلافه فقط** ومسمّى بأنه لا يُصرف:
          * إخفاؤه يجعل الفرق يظهر لاحقاً بلا تفسير، وإظهارُه دائماً يُنافس الرقم المجمَّد.
          */}
        {snap && (
          <div className="rounded-md border border-[var(--sem-info,var(--primary))]/40 bg-primary/5 p-2.5 space-y-1.5">
            <div className="flex items-start gap-2 text-xs">
              <Lock aria-hidden className="size-4 mt-0.5 shrink-0 text-primary" />
              <span>
                <span className="font-medium text-primary">
                  الشهر {snap.status === "paid" ? "مدفوع" : "معتمد"} — الأرقام مثبتة من مسيّر الرواتب.
                </span>{" "}
                لا تتغيّر بتعديلٍ لاحق على الراتب أو الجدول أو إعدادات الحضور. الجدول أدناه تفصيلٌ للاطّلاع.
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5 text-[11px]">
              {[
                { l: "الأجر الإجمالي", v: snap.gross },
                { l: "العمل الإضافي (أوفر تايم)", v: snap.overtime },
                { l: "العمولة", v: snap.commission },
                { l: "الاستقطاعات", v: snap.deductions },
                { l: "الصافي المصروف", v: snap.net, strong: true },
              ].map((x) => (
                <div key={x.l} className="rounded border bg-background p-1.5">
                  <div className="text-muted-foreground">{x.l}</div>
                  <div className={`tabular-nums ${x.strong ? "font-bold" : ""}`} dir="ltr">{iqd(x.v)}</div>
                </div>
              ))}
            </div>
            {Number(d.liveAmountDue) !== totalDue && (
              <div className="text-[11px] text-muted-foreground">
                الاشتقاق ببيانات اليوم يُعطي {iqd(d.liveAmountDue)} د.ع — الفرق أثرُ ما تغيّر بعد
                الاعتماد (ترقيةٌ أو تصحيحُ بصمة أو تبديلُ جدول)، <b>ولا يُصرف</b>.
              </div>
            )}
          </div>
        )}
        {d.employee.attendanceExempt && (
          <p className="text-xs rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2 leading-relaxed">
            <span className="font-medium text-[var(--sem-warn)]">راتب ثابت — لا يخضع للحضور.</span> يُصرف راتبه
            ومخصّصاته كاملةً بلا احتساب ساعات. الجدول أدناه للاطّلاع فقط ولا يؤثّر في مسيّره.
          </p>
        )}
        {!d.attendancePayEnabled && !d.employee.attendanceExempt && (
          <p className="text-xs text-muted-foreground rounded-md border p-2">
            الأجر بالحضور غير مفعَّل — الكشف يعرض الساعات والأسعار للمراجعة، لكنّ المسيّر
            ما زال يحتسب الراتب الثابت.
          </p>
        )}
        {d.totals.openDays > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-2.5 text-xs">
            <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-neg)]" />
            <span>
              <span className="font-medium text-[var(--sem-neg)]">{d.totals.openDays} يوم ببصمة دخولٍ بلا انصراف</span> —
              ساعاتها مجهولةٌ لا صفر، ولذلك تُعرَض «بصمة انصراف ناقصة» لا «غياب». صحّحها من زرّ «تصحيح»
              في صفّها؛ <span className="font-medium">توليد مسيّر هذا الشهر متوقّف حتى تُحسم</span> كي لا يُخصَم
              أجر يومٍ كامل بلا وجه.
            </span>
          </div>
        )}
        {d.totals.reviewDays > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
            <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
            <span>
              <span className="font-medium text-[var(--sem-warn)]">{d.totals.reviewDays} يوم يحتاج مراجعة</span> — بصمةُ
              خروجٍ ناقصة (أو عودةٌ لفترة ثانية بلا انصراف) أو ساعاتٌ تجاوزت السقف المعقول. اضغط «تصحيح» أمام اليوم لمراجعته وحسمه.
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          {[
            { l: "ساعات الدوام المطلوبة", sub: "حسب جدول الموظف للشهر", v: `${d.totals.scheduledHours} س` },
            { l: "الساعات المدفوعة المستحقّة", sub: "الداخلة في أجر الدوام الأساس", v: `${d.totals.payableHours} س` },
            { l: "الساعات الإضافية (أوفر تايم)", sub: "ما زاد عن المطلوب اليومي", v: `${d.totals.overtimeHours} س` },
            { l: "أيام الغياب", sub: "أيام عمل بلا حضور أو إجازة", v: `${d.totals.absentDays} يوم` },
          ].map((x) => (
            <div key={x.l} className="rounded-md border p-2.5 bg-muted/15">
              <div className="text-xs font-medium text-foreground">{x.l}</div>
              <div className="text-[10px] text-muted-foreground mb-1">{x.sub}</div>
              <div className="tabular-nums font-bold text-base" dir="ltr">{x.v}</div>
            </div>
          ))}
        </div>

        {/* دليل مبسّط يوضّح المصطلحات والدوام المجزّأ والاستراحة/الزمنية */}
        <div className="rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Info aria-hidden className="size-3.5 text-primary" />
            توضيح الأعمدة:
          </span>
          <span><b className="text-foreground">المطلوب:</b> ساعات اليوم في جدول الموظف</span>
          <span><b className="text-foreground">صافي العمل:</b> ساعات الدوام الأساس بعد طرح أي استراحة/زمنية</span>
          <span><b className="text-foreground">إضافي:</b> ما زاد عن المطلوب اليومي</span>
          <span><b className="text-foreground">دوام فترتين (استراحة/زمنية):</b> عند الخروج والعودة في نفس اليوم تُجمع فترات العمل الفعلي وتُطرح الاستراحة تلقائياً</span>
        </div>

        <ScrollTableShell bordered>
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">اليوم</th>
                <th className="p-2 text-center" title="وقت أوّل بصمة دخول في اليوم">الدخول</th>
                <th className="p-2 text-center" title="وقت آخر بصمة انصراف في اليوم">الانصراف</th>
                <th className="p-2 text-center" title="ساعات العمل المطلوبة لهذا اليوم في جدول الموظف">المطلوب</th>
                <th className="p-2 text-center" title="صافي ساعات العمل المحسوبة ضمن الدوام الأساس (بعد طرح الاستراحات/الزمنيات)">صافي العمل</th>
                <th className="p-2 text-center" title="الساعات الإضافية التي عملها الموظف فوق ساعات اليوم المطلوبة">إضافي</th>
                <th className="p-2 text-end">سعر الساعة</th>
                <th className="p-2 text-end">أجر الدوام</th>
                <th className="p-2 text-end">أجر الإضافي</th>
                <th className="p-2 text-end">إجمالي اليوم</th>
                <th className="p-2 text-start">الحالة والفترات</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {d.days.map((x: any) => {
                const sessionsList = Array.isArray(x.sessions) ? x.sessions : [];
                const hasMultiSessions = sessionsList.length > 1;
                const breakMins = Number(x.breakMinutes ?? 0);
                return (
                  <tr key={x.date} className={`border-t ${x.needsReview ? "bg-[var(--sem-warn-bg)]/50" : ""}`}>
                    <td className="p-2 tabular-nums" dir="ltr">{x.date}</td>
                    <td className="p-2">{x.dayName}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{x.checkIn ?? "—"}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">
                      {x.checkOut ? (
                        <>
                          {x.checkOut}
                          {x.checkOutNextDay ? (
                            <span className="ms-1 text-[10px] text-muted-foreground" title="انصراف بعد منتصف الليل (اليوم التالي)">(+1)</span>
                          ) : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{x.scheduledHours}</td>
                    <td className="p-2 text-center tabular-nums font-medium" dir="ltr">{x.countedHours}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{Number(x.overtimeHours) > 0 ? x.overtimeHours : "—"}</td>
                    <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(x.rate)}</td>
                    <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(x.amount)}</td>
                    <td className="p-2 text-end tabular-nums" dir="ltr">{Number(x.overtimeAmount) > 0 ? iqd(x.overtimeAmount) : "—"}</td>
                    <td className="p-2 text-end tabular-nums font-medium" dir="ltr">{iqd(x.totalAmount)}</td>
                    <td className="p-2 text-start">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="font-medium">{STATE_LABEL[x.state] ?? x.state}</span>
                        {x.source === "manual" ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">تعديل يدوي</span>
                        ) : null}
                        {breakMins > 0 && (
                          <span
                            className="inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 px-1.5 py-0.5 text-[10px]"
                            title="مدّة الاستراحة أو الزمنية المطروحة من إجمالي وقت البقاء"
                          >
                            <Coffee aria-hidden className="size-2.5" />
                            استراحة/زمنية: {formatDurationArabic(breakMins)}
                          </span>
                        )}
                      </div>
                      {hasMultiSessions && (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                          <Clock aria-hidden className="size-2.5 shrink-0 text-primary" />
                          <span>الفترات:</span>
                          {sessionsList.map((s: any, idx: number) => (
                            <span
                              key={idx}
                              dir="ltr"
                              className={`rounded border px-1 py-0.5 tabular-nums ${
                                s.checkOut == null
                                  ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] font-medium"
                                  : "bg-background"
                              }`}
                            >
                              {s.checkIn}→{s.checkOut ?? "بلا انصراف"}{s.crossMidnight ? "(+1)" : ""}
                            </span>
                          ))}
                        </div>
                      )}
                      {x.cleanNotes && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{x.cleanNotes}</div>
                      )}
                      {x.needsReview && x.reviewReason && x.reviewReason !== "manual_late_override" && (
                        <div className="mt-0.5 text-[10px] text-[var(--sem-warn)] font-medium">{x.reviewReason}</div>
                      )}
                    </td>
                    <td className="p-2 text-center">
                      {!snap && (
                        <button
                          className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
                          /*
                           * تُملأ بالساعات **الفعلية** لا المحتسَبة: المحتسَب مقصوصٌ عند المقرَّر
                           * (min(الفعلي، المقرَّر))، فتعبئتُه كانت تعني أن مجرّد فتح النافذة
                           * والحفظ يهبط بساعات اليوم إلى المقرَّر ⇒ **يُمحى الأوفر تايم صامتاً**.
                           */
                          onClick={() => {
                            const crossMidnight = Boolean(
                              x.checkOutNextDay || (x.checkIn && x.checkOut && x.checkOut <= x.checkIn),
                            );
                            const parsed = parseManualAttendanceEdit({
                              status: x.status,
                              state: x.state,
                              checkIn: x.checkIn,
                              checkOut: x.checkOut,
                              crossMidnight,
                              storedHours: x.attendedHours,
                              fallbackHours: x.countedHours,
                              notes: x.notes,
                              reviewReason: x.reviewReason,
                            });
                            const details = parseAttendanceDayDetails({
                              status: x.status,
                              state: x.state,
                              checkIn: x.checkIn,
                              checkOut: x.checkOut,
                              crossMidnight,
                              storedHours: x.attendedHours,
                              fallbackHours: x.countedHours,
                              notes: x.notes,
                              reviewReason: x.reviewReason,
                            });
                            const isSplit = details.sessions.length > 1;
                            const initSessions: ShiftEditRow[] = isSplit
                              ? details.sessions.map((s) => ({
                                  checkIn: s.checkIn,
                                  checkOut: s.checkOut ?? "",
                                  crossMidnight: Boolean(s.crossMidnight),
                                }))
                              : buildDefaultSplitSessions(x.checkIn, x.checkOut, { crossMidnight });
                            setFix({
                              date: x.date,
                              shiftMode: isSplit ? "split" : "single",
                              sessions: initSessions,
                              breakMinutes: details.breakMinutes > 0 ? String(details.breakMinutes) : "",
                              checkIn: x.checkIn ?? "",
                              checkOut: x.checkOut ?? "",
                              hours: parsed.hours,
                              crossMidnight,
                              status: parsed.status,
                              lateDeductionMinutes: parsed.lateDeductionMinutes,
                              notes: parsed.notes,
                            });
                          }}
                        >
                          <PenLine aria-hidden className="size-3" /> تصحيح
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-medium">
                <td className="p-2" colSpan={8}>{dueLabel}</td>
                <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(d.totals.basePay)}</td>
                <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(d.totals.overtimePay)}</td>
                <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(String(totalDue))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </ScrollTableShell>
      </CardContent>

      {/* تصحيح أوقات وساعات وحالة يومٍ بعينه — مع دعم الدوام المجزّأ (فترتين) والاستراحة/الزمنية */}
      <Dialog open={!!fix} onOpenChange={(o) => !o && setFix(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تصحيح دوام يوم {fix?.date}</DialogTitle>
          </DialogHeader>
          {fix && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>حالة اليوم</Label>
                <AppSelect
                  className="h-9 border-input px-2 text-sm"
                  value={fix.status}
                  onValueChange={(v) => {
                    const nextStatus = v as DayStatus;
                    if (nextStatus === "ABSENT" || nextStatus === "LEAVE") {
                      setFix({ ...fix, status: nextStatus, hours: "0", lateDeductionMinutes: "", breakMinutes: "" });
                    } else if (fix.shiftMode === "split") {
                      const summary = computeSessionsSummary(fix.sessions);
                      setFix({
                        ...fix,
                        status: nextStatus,
                        hours: summary.totalHours > 0 ? summary.totalHoursStr : "8",
                      });
                    } else {
                      const auto = spanHours(fix.checkIn, fix.checkOut, { crossMidnight: fix.crossMidnight });
                      const breakMins = Math.max(0, Number(fix.breakMinutes) || 0);
                      const net = auto != null ? Math.max(0, Math.round((auto - breakMins / 60) * 100) / 100) : null;
                      setFix({
                        ...fix,
                        status: nextStatus,
                        hours: net != null ? net.toFixed(2) : !(Number(fix.hours) > 0) ? "8" : fix.hours,
                      });
                    }
                  }}
                >
                  <option value="PRESENT">حضور</option>
                  <option value="LATE">تأخير</option>
                  <option value="ABSENT">غياب (٠ ساعة)</option>
                  <option value="LEAVE">إجازة (٠ ساعة)</option>
                </AppSelect>
              </div>

              {isPaidFixStatus && (
                <div className="space-y-1.5">
                  <Label>نظام الدوام في هذا اليوم</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const auto = spanHours(fix.checkIn, fix.checkOut, { crossMidnight: fix.crossMidnight });
                        const rawBreakMins = Math.max(0, Number(fix.breakMinutes) || 0);
                        const breakMins = auto != null && rawBreakMins / 60 >= auto ? 0 : rawBreakMins;
                        const net = auto != null ? Math.max(0, Math.round((auto - breakMins / 60) * 100) / 100) : null;
                        setFix({
                          ...fix,
                          shiftMode: "single",
                          breakMinutes: breakMins > 0 ? String(breakMins) : "",
                          hours: net != null ? net.toFixed(2) : fix.hours,
                        });
                      }}
                      className={`rounded-md border px-3 py-2 text-xs text-start transition-colors ${
                        fix.shiftMode === "single"
                          ? "border-primary bg-primary/10 font-medium text-primary"
                          : "border-input hover:bg-muted/50"
                      }`}
                    >
                      <div className="font-semibold">دوام متّصل (فترة واحدة)</div>
                      <div className="text-[10px] text-muted-foreground">دخول وانصراف مع خيار طرح استراحة/زمنية</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const existingCheck = computeSessionsSummary(fix.sessions);
                        const matchesCurrentBounds =
                          existingCheck.firstCheckIn === fix.checkIn &&
                          (existingCheck.lastCheckOut ?? "") === fix.checkOut;
                        const initialSessions: ShiftEditRow[] =
                          fix.sessions.length >= 2 &&
                          matchesCurrentBounds &&
                          (!existingCheck.violation || existingCheck.hasOpenSession)
                            ? fix.sessions
                            : buildDefaultSplitSessions(fix.checkIn, fix.checkOut, { crossMidnight: fix.crossMidnight });
                        const summary = computeSessionsSummary(initialSessions);
                        setFix({
                          ...fix,
                          shiftMode: "split",
                          sessions: initialSessions,
                          checkIn: summary.firstCheckIn ?? fix.checkIn,
                          checkOut: summary.lastCheckOut ?? fix.checkOut,
                          crossMidnight: summary.lastCrossMidnight,
                          breakMinutes: summary.breakMinutes > 0 ? String(summary.breakMinutes) : "",
                          hours: summary.totalHours > 0 ? summary.totalHoursStr : fix.hours,
                        });
                      }}
                      className={`rounded-md border px-3 py-2 text-xs text-start transition-colors ${
                        fix.shiftMode === "split"
                          ? "border-primary bg-primary/10 font-medium text-primary"
                          : "border-input hover:bg-muted/50"
                      }`}
                    >
                      <div className="font-semibold">دوام مجزّأ / فترتان (خروج وعودة)</div>
                      <div className="text-[10px] text-muted-foreground">خروج للاستراحة أو زمنية ثم عودة لإكمال الدوام</div>
                    </button>
                  </div>
                </div>
              )}

              {fix.shiftMode === "single" ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="fx-in">وقت الدخول</Label>
                      <Input id="fx-in" type="time" dir="ltr" value={fix.checkIn} onChange={(e) => setFixTime({ checkIn: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="fx-out">وقت الانصراف</Label>
                      <Input id="fx-out" type="time" dir="ltr" value={fix.checkOut} onChange={(e) => setFixTime({ checkOut: e.target.value })} />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="size-3.5"
                      checked={fix.crossMidnight}
                      onChange={(e) => setFixTime({ crossMidnight: e.target.checked })}
                    />
                    <span>انصراف بعد منتصف الليل (اليوم التالي +1)</span>
                  </label>

                  {isPaidFixStatus && (
                    <div className="rounded-md border bg-muted/20 p-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="fx-break" className="text-xs flex items-center gap-1.5">
                          <Coffee aria-hidden className="size-3.5 text-amber-600" />
                          استراحة / زمنية أثناء الدوام (دقائق — تُطرح من المدى)
                        </Label>
                        {Number(fix.breakMinutes) > 0 && (
                          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            {formatDurationArabic(Number(fix.breakMinutes))}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          id="fx-break"
                          type="number"
                          min={0}
                          max={720}
                          step="15"
                          dir="ltr"
                          placeholder="0"
                          className="h-8 text-xs w-28"
                          value={fix.breakMinutes}
                          onChange={(e) => setFixTime({ breakMinutes: e.target.value })}
                        />
                        <div className="flex flex-wrap gap-1">
                          {BREAK_PRESETS.map((p) => (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => setFixTime({ breakMinutes: p.mins })}
                              className={`rounded border px-2 py-1 text-[10px] transition-colors ${
                                fix.breakMinutes === p.mins
                                  ? "border-primary bg-primary/10 font-medium text-primary"
                                  : "bg-background hover:bg-muted"
                              }`}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="rounded-md border bg-muted/20 p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">فترات العمل الفعلي في هذا اليوم</span>
                    {fix.sessions.length < 4 && (
                      <button
                        type="button"
                        onClick={() =>
                          updateSplitSessions([...fix.sessions, suggestNextSplitSession(fix.sessions)])
                        }
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Plus aria-hidden className="size-3" /> إضافة فترة ثالثة
                      </button>
                    )}
                  </div>
                  {fix.sessions.map((s, idx) => {
                    const sSpan = spanHours(s.checkIn, s.checkOut, { crossMidnight: Boolean(s.crossMidnight) });
                    return (
                      <div key={idx} className="rounded border bg-background p-2 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium">
                            {idx === 0
                              ? "الفترة الأولى (قبل الاستراحة/الزمنية)"
                              : idx === 1
                                ? "الفترة الثانية (بعد العودة)"
                                : `الفترة رقم ${idx + 1}`}
                          </span>
                          <div className="flex items-center gap-2">
                            {sSpan != null && (
                              <span className="text-[11px] text-primary font-medium" dir="ltr">
                                {sSpan.toFixed(2)} س
                              </span>
                            )}
                            {fix.sessions.length > 2 && (
                              <button
                                type="button"
                                onClick={() => updateSplitSessions(fix.sessions.filter((_, i) => i !== idx))}
                                className="text-destructive hover:opacity-80"
                                title="حذف الفترة"
                              >
                                <Trash2 aria-hidden className="size-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-[10px] text-muted-foreground">وقت الدخول</Label>
                            <Input
                              type="time"
                              dir="ltr"
                              className="h-8 text-xs"
                              value={s.checkIn}
                              onChange={(e) => {
                                const next = fix.sessions.map((row, i) =>
                                  i === idx ? { ...row, checkIn: e.target.value } : row,
                                );
                                updateSplitSessions(next);
                              }}
                            />
                          </div>
                          <div>
                            <Label className="text-[10px] text-muted-foreground">وقت الانصراف</Label>
                            <Input
                              type="time"
                              dir="ltr"
                              className="h-8 text-xs"
                              value={s.checkOut}
                              onChange={(e) => {
                                const val = e.target.value;
                                const next = fix.sessions.map((row, i) =>
                                  i === idx
                                    ? {
                                        ...row,
                                        checkOut: val,
                                        crossMidnight: Boolean(row.checkIn && val && val <= row.checkIn),
                                      }
                                    : row,
                                );
                                updateSplitSessions(next);
                              }}
                            />
                          </div>
                        </div>
                        {idx === fix.sessions.length - 1 && (
                          <label className="flex items-center gap-2 text-[11px] text-muted-foreground pt-0.5">
                            <input
                              type="checkbox"
                              className="size-3"
                              checked={Boolean(s.crossMidnight)}
                              onChange={(e) => {
                                const next = fix.sessions.map((row, i) =>
                                  i === idx ? { ...row, crossMidnight: e.target.checked } : row,
                                );
                                updateSplitSessions(next);
                              }}
                            />
                            <span>انصراف هذه الفترة بعد منتصف الليل (+1)</span>
                          </label>
                        )}
                      </div>
                    );
                  })}

                  {splitSummary && splitSummary.breaks.length > 0 && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5">
                        <Coffee aria-hidden className="size-3.5" />
                        استراحة / زمنية بين الفترات ({splitSummary.breaks.map((b) => `${b.from}←${b.to}`).join(" ، ")}):
                      </span>
                      <span className="font-semibold">
                        {formatDurationArabic(splitSummary.breakMinutes)} (تُطرح تلقائياً)
                      </span>
                    </div>
                  )}
                  {splitSummary && splitSummary.hasOpenSession && (
                    <div className="text-xs text-[var(--sem-warn)]">
                      الفترة التي بدأت عند {splitSummary.openSessionCheckIn} لا يزال ينقصها وقت الانصراف — أدخل وقت انصرافها لإكمال احتسابها.
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="fx-h">صافي ساعات العمل المحتسَبة لليوم</Label>
                  {fix.shiftMode === "single" &&
                    fixSingleNetSpan != null &&
                    isPaidFixStatus &&
                    Math.abs(Number(fix.hours) - fixSingleNetSpan) > 0.01 && (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => setFix({ ...fix, hours: fixSingleNetSpan.toFixed(2) })}
                      >
                        حساب تلقائي من الوقتين والاستراحة ({fixSingleNetSpan.toFixed(2)} س)
                      </button>
                    )}
                  {fix.shiftMode === "split" &&
                    splitSummary &&
                    splitSummary.totalHours > 0 &&
                    isPaidFixStatus &&
                    Math.abs(Number(fix.hours) - splitSummary.totalHours) > 0.01 && (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => setFix({ ...fix, hours: splitSummary.totalHoursStr })}
                      >
                        مجموع الفترات ({splitSummary.totalHoursStr} س)
                      </button>
                    )}
                </div>
                <Input
                  id="fx-h"
                  type="number"
                  min={0}
                  max={24}
                  step="0.25"
                  dir="ltr"
                  disabled={!isPaidFixStatus}
                  value={fix.hours}
                  onChange={(e) => setFix({ ...fix, hours: e.target.value })}
                />
                {fixError ? (
                  <p className="text-xs leading-relaxed text-[var(--sem-neg)]">{fixError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {!isPaidFixStatus
                      ? "الغياب والإجازة يُسجَّلان بصفر ساعات عمل."
                      : fix.shiftMode === "split" && splitSummary
                        ? `مجموع فترات الدوام الفعلي = ${splitSummary.totalHoursStr} ساعة (بعد استبعاد ${formatDurationArabic(splitSummary.breakMinutes)} استراحة/زمنية).`
                        : fixSingleNetSpan != null
                          ? `صافي الساعات = ${fixSingleNetSpan.toFixed(2)} ساعة${Number(fix.breakMinutes) > 0 ? ` (المدى ${fixSpan?.toFixed(2)} س ناقص ${formatDurationArabic(Number(fix.breakMinutes))} استراحة/زمنية)` : ""}.`
                          : "أدخِل وقتَي الدخول والانصراف للحساب التلقائي، أو أدخِل الساعات يدوياً مباشرةً."}
                  </p>
                )}
              </div>
              {isPaidFixStatus && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="fx-late">خصم تأخير إداري (دقائق — اختياري)</Label>
                    <Input
                      id="fx-late"
                      type="number"
                      min={0}
                      max={720}
                      step="5"
                      dir="ltr"
                      placeholder="0"
                      value={fix.lateDeductionMinutes}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        const hadDeduction = Number(fix.lateDeductionMinutes) > 0;
                        const hasDeduction = Number(nextVal) > 0;
                        setFix({
                          ...fix,
                          lateDeductionMinutes: nextVal,
                          status: hadDeduction && !hasDeduction && fix.status === "LATE" ? "PRESENT" : fix.status,
                        });
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="fx-notes">ملاحظة</Label>
                    <Input
                      id="fx-notes"
                      value={fix.notes}
                      placeholder="سبب التعديل أو الزمنية…"
                      onChange={(e) => setFix({ ...fix, notes: e.target.value })}
                    />
                  </div>
                </div>
              )}
              {isPaidFixStatus && Number(fix.lateDeductionMinutes) > 0 && (
                <p className="text-xs text-[var(--sem-warn)]">
                  سيُخصم {Number(fix.lateDeductionMinutes)} دقيقة ({(Number(fix.lateDeductionMinutes) / 60).toFixed(2)} ساعة) من الساعات المسجَّلة ليصبح الصافي{" "}
                  {Math.max(0, (Number(fix.hours) || 0) - Number(fix.lateDeductionMinutes) / 60).toFixed(2)} ساعة.
                </p>
              )}
              <p className="text-xs text-muted-foreground leading-relaxed">
                التصحيح اليدويّ يُثبّت اليوم ويرفع وسم المراجعة، ولا يطمسه الجهاز أو إعادة المزامنة لاحقاً.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFix(null)}>إلغاء</Button>
            <Button
              disabled={!can("attendance.record") || (correct.isPending || !fix || !!fixError)}
              onClick={() => {
                if (!fix) return;
                const parsedLate = Number(fix.lateDeductionMinutes);
                const lateMin =
                  isPaidFixStatus && fix.lateDeductionMinutes.trim() !== "" && Number.isFinite(parsedLate) && parsedLate > 0
                    ? Math.round(parsedLate)
                    : undefined;
                const parsedBreak = Number(fix.breakMinutes);
                const breakMin =
                  isPaidFixStatus && Number.isFinite(parsedBreak) && parsedBreak > 0
                    ? Math.round(parsedBreak)
                    : 0;
                correct.mutate({
                  employeeId,
                  attendanceDate: fix.date,
                  hours: isPaidFixStatus ? Number(fix.hours) || 0 : 0,
                  status: lateMin && lateMin > 0 && fix.status === "PRESENT" ? "LATE" : fix.status,
                  checkIn: fix.checkIn || undefined,
                  checkOut: fix.checkOut || undefined,
                  checkOutDate: fix.crossMidnight && fix.checkOut ? nextDateStr(fix.date) : undefined,
                  lateDeductionMinutes: lateMin,
                  sessions:
                    isPaidFixStatus && fix.shiftMode === "split"
                      ? fix.sessions.filter((s) => s.checkIn || s.checkOut)
                      : undefined,
                  breakMinutes: breakMin,
                  notes: fix.notes.trim() || undefined,
                  source: "manual",
                });
              }}
            >
              {correct.isPending ? "جارٍ الحفظ…" : "حفظ التصحيح"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

