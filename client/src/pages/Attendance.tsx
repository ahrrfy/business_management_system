import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FilterField, ListToolbar } from "@/components/list";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/PageHeader";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { WEEK_DAYS } from "@shared/hr";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  attendanceHoursViolation,
  buildDefaultSplitSessions,
  computeSessionsSummary,
  formatDurationArabic,
  parseManualAttendanceEdit,
  spanHours,
  suggestNextSplitSession,
  type AttendanceSessionInput,
} from "@shared/attendanceHours";
import { Clock, Coffee, Fingerprint, PenLine, Plus, RefreshCw, Split, Trash2, TriangleAlert, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { selectClsSm } from "@/lib/ui/formStyles";

type AttendanceRow = RouterOutputs["attendance"]["list"]["rows"][number];
type DayStatus = "PRESENT" | "LATE" | "ABSENT" | "LEAVE";

/** حجم صفحة السجلّ — الخادم يُرقّم (سقفه ٥٠٠). */
const PAGE_SIZE = 50;


/** الشهر الحالي بصيغة "YYYY-MM". */
const currentMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/** اليوم التالي بصيغة YYYY-MM-DD (لأوقات الانصراف بعد منتصف الليل). */
function nextDateStr(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** اسم الشهر بالعربية للعرض (من "YYYY-MM"). */
const MONTH_NAMES = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"];
function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
}
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

function StatCard({ label, value, sub, icon, accent }: { label: string; value: string; sub?: string; icon: React.ReactNode; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-2xl font-bold tabular-nums mt-1" dir="ltr" style={accent ? { color: accent } : undefined}>{value}</div>
          {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
        </div>
        <span className="shrink-0 text-muted-foreground" style={accent ? { color: accent } : undefined}>{icon}</span>
      </CardContent>
    </Card>
  );
}

const emptyForm = () => ({
  employeeId: "",
  attendanceDate: today(),
  mode: "single" as "single" | "split",
  hours: "",
  checkIn: "",
  checkOut: "",
  crossMidnight: false,
  breakMinutes: "",
  sessions: [
    { checkIn: "08:00", checkOut: "12:00" },
    { checkIn: "14:00", checkOut: "18:00" },
  ] as AttendanceSessionInput[],
  status: "PRESENT" as DayStatus,
  lateDeductionMinutes: "",
  notes: "",
  isEditing: false,
});

/**
 * نطاق السجلّ — **يفتح على اليوم** بقرار المالك (١/٨): «سجلّ الحضور يجب أن يكون الافتراضيّ
 * تاريخ اليوم مع إمكانية البحث والاستعلام عن بقية التواريخ». فتحُ الشهر كاملاً كان يُغرق
 * الشاشة بصفوفٍ لا تخصّ اللحظة، ومراجعةُ الصباح تخصّ اليوم.
 */
const RANGES = [
  { key: "today", label: "اليوم" },
  { key: "yesterday", label: "أمس" },
  { key: "week", label: "آخر ٧ أيام" },
  { key: "month", label: "الشهر" },
  { key: "custom", label: "مدى مخصّص" },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

/** تاريخ اليوم **بتوقيت الجهاز** لا UTC: تواريخ البصمات توقيتُ حائطٍ محليّ، وقبل الثالثة
 *  فجراً كان UTC يُرجع «أمس» فيفتح السجلّ على يومٍ فارغ. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
/** حدّا المدى لكل نطاق — `null` يعني «بلا حدّ» (الشهر يُمرَّر بـperiod). */
function rangeBounds(key: RangeKey, from: string, to: string): { dateFrom?: string; dateTo?: string } {
  const t = todayLocal();
  if (key === "today") return { dateFrom: t, dateTo: t };
  if (key === "yesterday") return { dateFrom: shiftDays(t, -1), dateTo: shiftDays(t, -1) };
  if (key === "week") return { dateFrom: shiftDays(t, -6), dateTo: t };
  if (key === "custom") return { dateFrom: from || undefined, dateTo: to || undefined };
  return {}; // الشهر
}

export default function Attendance() {
  const [, navigate] = useLocation();
  // فلاتر محفوظة في querystring (تعيش مع فتح بطاقة موظف والرجوع، وتُشارَك رابطاً).
  const [f, setF, resetF] = useUrlFilters({
    employeeId: "", period: currentMonth(), range: "today", customFrom: todayLocal(), customTo: todayLocal(),
    source: "", reviewOnly: "", q: "",
  });
  const range = f.range as RangeKey;
  /*
   * «اليوم» يتقدّم عند منتصف الليل المحليّ (Codex P2): شاشة الحضور تبقى مفتوحةً ليلاً،
   * وحدودُ المدى كانت تُشتقّ مرّةً واحدة فتبقى معلّقةً على الأمس حتى يلمس المستخدم فلتراً.
   */
  const [dayTick, setDayTick] = useState(todayLocal());
  useEffect(() => {
    const t = setInterval(() => setDayTick((prev) => { const now = todayLocal(); return now === prev ? prev : now; }), 60_000);
    return () => clearInterval(t);
  }, []);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());

  const setFormTime = (patch: { checkIn?: string; checkOut?: string; crossMidnight?: boolean }) =>
    setForm((cur) => {
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
      const brk = Math.max(0, Number(next.breakMinutes) || 0);
      const net = Math.max(0, Math.round((auto - brk / 60) * 100) / 100);
      return { ...next, hours: net.toFixed(2) };
    });

  const applyBreakMinutes = (val: string) =>
    setForm((cur) => {
      const next = { ...cur, breakMinutes: val };
      if (next.mode !== "single" || next.status === "ABSENT" || next.status === "LEAVE") return next;
      const auto = spanHours(next.checkIn, next.checkOut, { crossMidnight: next.crossMidnight });
      if (auto == null) return next;
      const brk = Math.max(0, Number(val) || 0);
      const net = Math.max(0, Math.round((auto - brk / 60) * 100) / 100);
      return { ...next, hours: net.toFixed(2) };
    });

  const applySplitSessions = (nextSessions: AttendanceSessionInput[]) =>
    setForm((cur) => {
      const res = computeSessionsSummary(nextSessions);
      return {
        ...cur,
        sessions: nextSessions,
        hours:
          cur.status === "ABSENT" || cur.status === "LEAVE"
            ? "0"
            : res.violation
              ? cur.hours
              : res.totalHours.toFixed(2),
        checkIn: res.firstCheckIn || cur.checkIn,
        checkOut: res.lastCheckOut || cur.checkOut,
        breakMinutes: res.breakMinutes > 0 ? String(res.breakMinutes) : "",
        crossMidnight: res.lastCrossMidnight,
      };
    });

  const formSpan = spanHours(form.checkIn, form.checkOut, { crossMidnight: form.crossMidnight });
  const splitSummary = form.mode === "split" ? computeSessionsSummary(form.sessions) : null;
  const isPaidFormStatus = form.status === "PRESENT" || form.status === "LATE";
  const formError =
    form.mode === "split"
      ? isPaidFormStatus
        ? splitSummary?.violation ?? null
        : null
      : form.hours.trim() !== "" || (form.checkIn && form.checkOut)
        ? attendanceHoursViolation({
            checkIn: form.checkIn,
            checkOut: form.checkOut,
            hours: Number(form.hours || 0),
            isPaidStatus: isPaidFormStatus,
            crossMidnight: form.crossMidnight,
            breakMinutes: Number(form.breakMinutes) || 0,
          })
        : null;

  const utils = trpc.useUtils();
  const opts = trpc.attendance.formOptions.useQuery();

  // فلتر البطاقات (بلا بحث): البطاقات مؤشّرُ الشهر/الفلتر — سلوك محفوظ كما كان.
  const bounds = useMemo(() => rangeBounds(range, f.customFrom, f.customTo), [range, f.customFrom, f.customTo, dayTick]);
  /** مدىً مخصّصٌ فُرِّغ حقلاه = «بلا حدّ» صراحةً ⇒ لا يُمرَّر الشهر المخفيّ فيُقيّد صامتاً. */
  const customUnbounded = range === "custom" && !bounds.dateFrom && !bounds.dateTo;
  const filterInput = useMemo(
    () => ({
      employeeId: f.employeeId ? Number(f.employeeId) : undefined,
      // المدى يتقدّم على الشهر خادمياً؛ نُمرّر الشهر ليبقى نطاقُ زرّ الإصلاح معلوماً — إلا
      // في مدىً مخصّصٍ فارغ الحقلين، فإرسالُه هناك يُقيّد بشهرٍ مخفيٍّ لا يراه المستخدم.
      period: customUnbounded ? undefined : f.period || undefined,
      ...bounds,
      source: (f.source || undefined) as "fingerprint" | "manual" | undefined,
      needsReviewOnly: f.reviewOnly === "1" || undefined,
    }),
    [f.employeeId, f.period, bounds, customUnbounded, f.source, f.reviewOnly],
  );
  /** الشهر الذي يُصلحه زرّ إعادة الاحتساب — من نهاية المدى المعروض (وإلا الشهر المختار). */
  const activePeriod = (bounds.dateTo || bounds.dateFrom || f.period).slice(0, 7);
  const rangeLabel =
    range === "month"
      ? monthLabel(f.period)
      : bounds.dateFrom && bounds.dateFrom === bounds.dateTo
        ? bounds.dateFrom
        : `${bounds.dateFrom ?? "…"} ← ${bounds.dateTo ?? "…"}`;

  // عدّاد الفلاتر المفعّلة (بلا حقل البحث — اتفاقية ListToolbar) لزرّ «مسح الفلاتر».
  const activeFilterCount = [
    f.employeeId, range !== "today" ? f.range : "", f.source, f.reviewOnly === "1" ? "1" : "",
  ].filter(Boolean).length;

  // البحث خادميّ الآن (اسم/تاريخ/يوم): كان يُصفّي الصفوف المُحمَّلة وحدها (سقف ٣٠٠) ⇒ يقول
  // «لا نتائج» عن سجلٍّ موجود خارج السقف. debounce ليكتب المستخدم بلا طلبٍ لكل حرف.
  const dq = useDebouncedValue(f.q.trim(), 300);
  const listInput = useMemo(() => ({ ...filterInput, q: dq || undefined }), [filterInput, dq]);

  // الترقيم خادميّ: كانت تُحمَّل كل السجلّات المطابقة دفعةً — وبإفراغ منتقي الشهر تُمسح كل
  // سجلّات الحضور مدى الحياة (موظفون × أيام × سنوات) في حمولةٍ واحدة.
  const [page, setPage] = useState(0);
  const filterKey = JSON.stringify(listInput);
  useEffect(() => { setPage(0); }, [filterKey]);

  const list = trpc.attendance.list.useQuery({ ...listInput, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  // بطاقات المؤشّرات — مجاميع خادمية لكل المطابق للفلتر (كانت تُحسب من الصفوف المُحمَّلة ⇒ تكذب
  // بمجرّد تجاوز السقف). المبالغ نصّية من SUM على decimal ⇒ تمرّ عبر D() بلا parseFloat (§٥).
  const summary = trpc.attendance.summary.useQuery(filterInput);
  const totalHours = D(summary.data?.hours ?? 0);
  const totalAmount = D(summary.data?.amount ?? 0);
  const fingerprintCount = summary.data?.fingerprintCount ?? 0;
  const manualCount = summary.data?.manualCount ?? 0;
  /*
   * مجاميعُ جزئية تُعلَن جزئيةً (Codex P1): المسح الحيّ محدودٌ بسقف، ونطاقٌ يتجاوزه يُنتج
   * مبلغاً ناقصاً. عرضُه كرقمٍ نهائيّ كذبٌ ماليّ صامت — نسبقه بـ«≥» ونشرحه.
   */
  const partialTotals = !!summary.data?.capped || !!list.data?.totals.capped;
  const approx = (v: string) => (partialTotals ? `≥ ${v}` : v);

  // مجاميع ذيل الجدول تتبع المطابق للفلتر **والبحث** (لا الصفحة) — خادمية بنفس شروط الصفوف.
  const visHours = D(list.data?.totals.hours ?? 0);
  const visAmount = D(list.data?.totals.amount ?? 0);

  /*
   * صفوفٌ سعرُها المخزَّن يخالف ملفّ الموظف الآن — لقطةٌ كُتبت قبل ضبط جدوله أو قبل تعديل
   * راتبه. الأعمدة تعرض المُشتقّ الحيّ (ما سيُدفع فعلاً)، والمجاميع من المخزَّن ⇒ لا بدّ من
   * إعادة احتساب ليتطابقا — ولأنّ لقطة الساعيّ هي وعاء أجره في المسيّر فعلاً.
   */
  const staleCount = list.data?.staleCount ?? 0;
  /** الأشهر التي فيها لقطاتٌ قديمة فعلاً — قد تتعدّد إن عبَر المدى حدَّ الشهر. */
  const stalePeriods = list.data?.stalePeriods ?? [];
  const recompute = trpc.attendance.recomputeRates.useMutation({ onError: (e) => notify.err(e) });
  const [fixing, setFixing] = useState(false);

  /** يُعيد طيّ البصمات ويُصحّح الساعات والأسعار للأشهر المطلوبة مع الحفاظ التامّ على التعديلات اليدوية. */
  async function runSmartRecompute(targetPeriods?: string[]) {
    if (fixing) return;
    const periods = targetPeriods?.length
      ? Array.from(new Set(targetPeriods))
      : stalePeriods.length
        ? Array.from(new Set([...stalePeriods, activePeriod]))
        : [activePeriod];
    if (!periods.length) return;
    setFixing(true);
    try {
      let totalChanged = 0;
      for (const p of periods) {
        const r = await recompute.mutateAsync({ period: p, employeeId: f.employeeId ? Number(f.employeeId) : undefined });
        totalChanged += (r.updated ?? 0) + (r.refoldedDays ?? 0) + (r.cleanedGhostDays ?? 0);
      }
      notify.ok(
        totalChanged > 0
          ? `تم تحديث البصمات وإعادة احتساب ${totalChanged} يوم في ${periods.length > 1 ? `${periods.length} أشهر` : monthLabel(periods[0])}`
          : "تمّ التحقّق من البصمات — كل الساعات والأسعار مطابقة لملفّات الموظفين",
      );
      await Promise.all([
        utils.attendance.list.invalidate(),
        utils.attendance.summary.invalidate(),
        utils.attendance.employeeStatement.invalidate(),
      ]);
    } catch {
      // notify.err عُرِضت في onError — نُبطّل الكاش كي يظهر ما نجح إصلاحُه قبل الفشل.
      await Promise.all([utils.attendance.list.invalidate(), utils.attendance.summary.invalidate()]);
    } finally {
      setFixing(false);
    }
  }

  const record = trpc.attendance.record.useMutation({
    onSuccess: async () => {
      notify.ok(form.isEditing ? "تم حفظ تصحيح الدوام" : "تم تسجيل الحضور");
      setOpen(false);
      setForm(emptyForm());
      // البطاقات صارت خادمية ⇒ تُبطَّل مع القائمة وإلا بقيت مجاميعها قديمة بعد الإدخال.
      await Promise.all([
        utils.attendance.list.invalidate(),
        utils.attendance.summary.invalidate(),
        utils.attendance.employeeStatement.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e),
  });

  function openRowCorrection(r: AttendanceRow) {
    const dateStr = String(r.attendanceDate ?? "").slice(0, 10) || today();
    const inHm = r.checkIn ? new Date(r.checkIn).toISOString().slice(11, 16) : "";
    const outHm = r.checkOut ? new Date(r.checkOut).toISOString().slice(11, 16) : "";
    const outDate = r.checkOut ? new Date(r.checkOut).toISOString().slice(0, 10) : dateStr;
    const crossMidnight = Boolean(inHm && outHm && (outDate > dateStr || outHm <= inHm));
    const parsed = parseManualAttendanceEdit({
      status: r.status,
      checkIn: inHm,
      checkOut: outHm,
      crossMidnight,
      storedHours: r.hours,
      notes: r.notes,
      reviewReason: r.reviewReason,
    });
    const isSplit = Boolean(r.hasMultipleSessions && r.sessions && r.sessions.length >= 2);
    const defaultSplitSessions: AttendanceSessionInput[] = isSplit
      ? r.sessions.map((s) => ({ checkIn: s.checkIn, checkOut: s.checkOut ?? "", crossMidnight: Boolean(s.crossMidnight) }))
      : buildDefaultSplitSessions(inHm, outHm, { crossMidnight });
    setForm({
      employeeId: String(r.employeeId),
      attendanceDate: dateStr,
      mode: isSplit ? "split" : "single",
      hours: parsed.hours,
      checkIn: inHm,
      checkOut: outHm,
      crossMidnight,
      breakMinutes: (r.breakMinutes ?? 0) > 0 ? String(r.breakMinutes) : "",
      sessions: defaultSplitSessions,
      status: parsed.status,
      lateDeductionMinutes: parsed.lateDeductionMinutes,
      notes: parsed.notes,
      isEditing: true,
    });
    setOpen(true);
  }

  function submit() {
    if (!form.employeeId) return notify.warn("اختر الموظف");
    const hours = isPaidFormStatus ? Number(form.hours) : 0;
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) return notify.warn("أدخل عدد ساعات صحيح (٠–٢٤)");
    if (formError) return notify.warn(formError);
    const parsedLate = Number(form.lateDeductionMinutes);
    const lateMin =
      isPaidFormStatus && form.lateDeductionMinutes.trim() !== "" && Number.isFinite(parsedLate) && parsedLate > 0
        ? Math.round(parsedLate)
        : undefined;
    const parsedBrk = Number(form.breakMinutes);
    const brkMin =
      isPaidFormStatus && form.breakMinutes.trim() !== "" && Number.isFinite(parsedBrk) && parsedBrk > 0
        ? Math.round(parsedBrk)
        : undefined;
    record.mutate({
      employeeId: Number(form.employeeId),
      attendanceDate: form.attendanceDate,
      hours,
      status: lateMin && lateMin > 0 && form.status === "PRESENT" ? "LATE" : form.status,
      checkIn:
        form.mode === "split"
          ? splitSummary?.firstCheckIn || undefined
          : form.checkIn.trim() || undefined,
      checkOut:
        form.mode === "split"
          ? splitSummary?.lastCheckOut || undefined
          : form.checkOut.trim() || undefined,
      checkOutDate:
        (form.mode === "single" ? form.crossMidnight && Boolean(form.checkOut.trim()) : Boolean(splitSummary?.lastCrossMidnight))
          ? nextDateStr(form.attendanceDate)
          : undefined,
      sessions: form.mode === "split" && isPaidFormStatus ? form.sessions : undefined,
      breakMinutes: form.mode === "split" ? splitSummary?.breakMinutes : brkMin,
      lateMinutes: lateMin,
      lateDeductionMinutes: lateMin,
      notes: form.notes.trim() || undefined,
      source: "manual",
    });
  }

  /*
   * أعمدة سجلّ الحضور — داخل المكوّن: خليّة الموظف تُبحر إلى ملفّه، والذيل يحمل مجاميع
   * خادمية لكل المطابق للفلتر والبحث (لا لصفحة الجدول) موسومةً بـ«≥» حين تكون جزئية.
   */
  const attendanceColumns = useMemo<ColumnDef<AttendanceRow, unknown>[]>(() => [
    {
      id: "employee",
      header: "الموظف",
      accessorFn: (r) => r.employeeName ?? "",
      meta: { width: "wide", wrap: true },
      footer: "الإجمالي",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div>
            <button onClick={() => navigate(`/hr/employees/${r.employeeId}`)} className="flex items-center gap-2 hover:text-primary">
              <EmpAvatar name={r.employeeName} color={r.colorTag} photoUrl={r.photoUrl} sizePx={28} />
              <span className="text-[13px] font-medium">{r.employeeName}</span>
            </button>
            {r.cleanNotes && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">{r.cleanNotes}</div>
            )}
            {/* يومٌ ينقصه إغلاق: لا يُخمَّن أجره — يُصحَّح يدوياً قبل إغلاق الشهر. */}
            {r.needsReview && (
              <div
                className="mt-1 inline-flex items-center gap-1 rounded-full border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] text-[var(--sem-warn)]"
                title={r.reviewReason ?? "ينقص تسجيل خروج"}
              >
                <TriangleAlert aria-hidden className="size-3" />
                {r.reviewReason ?? "يحتاج تصحيح"}
              </div>
            )}
          </div>
        );
      },
    },
    { id: "dayName", header: "اليوم", accessorFn: (r) => r.dayName ?? "", cell: ({ row }) => <span className="text-[13px]">{row.original.dayName}</span> },
    { id: "attendanceDate", header: "التاريخ", accessorFn: (r) => String(r.attendanceDate ?? ""), meta: { kind: "date" }, cell: ({ row }) => <span className="text-xs">{row.original.attendanceDate}</span> },
    {
      id: "checkIn",
      header: "أول دخول",
      accessorFn: (r) => (r.checkIn ? new Date(r.checkIn).toISOString().slice(11, 16) : "—"),
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => (row.original.checkIn ? new Date(row.original.checkIn).toISOString().slice(11, 16) : "—"),
    },
    {
      id: "checkOut",
      header: "آخر خروج",
      accessorFn: (r) => (r.checkOut ? new Date(r.checkOut).toISOString().slice(11, 16) : "—"),
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => {
        const r = row.original;
        if (!r.checkOut) return "—";
        const outHm = new Date(r.checkOut).toISOString().slice(11, 16);
        const nextDay = new Date(r.checkOut).toISOString().slice(0, 10) > String(r.attendanceDate ?? "").slice(0, 10);
        return (
          <span>
            {outHm}
            {nextDay ? <span className="ms-1 text-[10px] text-muted-foreground">(+1)</span> : null}
          </span>
        );
      },
    },
    {
      id: "hours",
      header: "صافي الساعات",
      accessorFn: (r) => Number(r.hours ?? 0),
      meta: { kind: "number", align: "center", wrap: true },
      footer: approx(visHours.toNumber().toLocaleString("en-US")),
      cell: ({ row }) => {
        const r = row.original;
        const hrs = Number(r.hours ?? 0);
        return (
          <div className="space-y-0.5">
            <div className="font-medium tabular-nums" dir="ltr">{hrs}</div>
            {r.hasMultipleSessions && r.sessions && (
              <div
                className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                title={`دوام مجزّأ (${r.sessions.length} فترات)`}
              >
                <Split aria-hidden className="size-2.5" />
                <span dir="ltr" className="tabular-nums">
                  {r.sessions.map((s) => `${s.checkIn}→${s.checkOut ?? "؟"}${s.crossMidnight ? "(+1)" : ""}`).join(" · ")}
                </span>
              </div>
            )}
            {(r.breakMinutes ?? 0) > 0 && (
              <div className="block text-[10px] text-muted-foreground">
                <Coffee aria-hidden className="inline size-2.5 me-0.5" />
                استراحة/زمنية: {formatDurationArabic(r.breakMinutes)}
              </div>
            )}
            {r.hasMultipleSessions && r.hasOpenSession && r.openSessionCheckIn && (
              <div className="block text-[10px] text-[var(--sem-warn)]">
                فترة ثانية مفتوحة ({r.openSessionCheckIn}←؟)
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "hourlyRate",
      header: "سعر الساعة",
      accessorFn: (r) => iqd(r.hourlyRate),
      meta: { kind: "money", wrap: true },
      // السعر مُشتقٌّ من ملفّ الموظف الآن — والمخزَّن المخالف يُعرَض مشطوباً لا يُخفى.
      cell: ({ row }) => {
        const r = row.original;
        const weekend = r.dayName === "الجمعة" || r.dayName === "السبت";
        return (
          <span className={weekend ? "text-[var(--stock-low)] font-medium" : undefined}>
            {iqd(r.hourlyRate)}
            {r.rateStale && (
              <span className="block text-[10px] text-[var(--sem-warn)] line-through" title="السعر المخزَّن قديم — أعد الاحتساب">
                {iqd(r.storedHourlyRate)}
              </span>
            )}
            {r.rateBasis === "none" && (
              <span className="block text-[10px] text-[var(--sem-warn)]" title="لا سعر ساعةٍ ولا راتب في ملفّ هذا الموظف">
                بلا سعر في الملف
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "amount",
      header: "أجر اليوم",
      accessorFn: (r) => iqd(r.amount),
      meta: { kind: "money", wrap: true },
      footer: approx(iqd(visAmount.toFixed(2))),
      cell: ({ row }) => (
        <span className="font-semibold">
          {iqd(row.original.amount)}
          {row.original.rateStale && (
            <span className="block text-[10px] font-normal text-[var(--sem-warn)] line-through">{iqd(row.original.storedAmount)}</span>
          )}
        </span>
      ),
    },
    {
      id: "source",
      header: "المصدر",
      accessorFn: (r) => (r.source === "fingerprint" ? "بصمة" : "يدوي"),
      meta: { kind: "status" },
      cell: ({ row }) =>
        row.original.source === "fingerprint" ? (
          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Fingerprint className="size-3.5" /> بصمة</span>
        ) : (
          <span className="text-[11px] text-[var(--stock-low)] inline-flex items-center gap-1"><PenLine className="size-3.5" /> يدوي</span>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const r = row.original;
        if (r.periodLocked) {
          return <span className="text-[11px] text-muted-foreground">مقفل</span>;
        }
        return (
          <button
            type="button"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            onClick={() => openRowCorrection(r)}
          >
            <PenLine aria-hidden className="size-3" /> تصحيح
          </button>
        );
      },
    },
  ], [navigate, partialTotals, visHours, visAmount]);

  return (
    <div className="space-y-4">
      {/* الترويسة */}
      <PageHeader
        title="الحضور والانصراف"
        description="نظام احتساب بالساعة — أجر اليوم = صافي ساعات العمل × سعر ساعة ذلك اليوم. يدعم الدوام المتصل، الاستراحة/الزمنية، والدوام المجزّأ على فترتين أو أكثر."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              disabled={fixing}
              onClick={() => void runSmartRecompute()}
              title="مزامنة وتحديث بصمات الشهر وإعادة احتساب الساعات والأسعار تلقائياً مع الحفاظ على التعديلات اليدوية"
            >
              <RefreshCw aria-hidden className={`size-4 ${fixing ? "animate-spin" : ""}`} />
              {fixing ? ACTION_LABELS.processing : `تحديث البصمات وإعادة الاحتساب (${monthLabel(activePeriod)})`}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/reports/attendance-monthly"><Clock className="size-4" /> التقرير الشهريّ</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/hr/devices"><Fingerprint className="size-4" /> أجهزة البصمة</Link>
            </Button>
          </div>
        }
      />

      {/* مؤشرات */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label={`صافي ساعات ${rangeLabel}`} value={approx(totalHours.toNumber().toLocaleString("en-US"))} sub={partialTotals ? "مجموعٌ جزئيّ — ضيّق النطاق" : "حسب النطاق المختار"} icon={<Clock className="size-5" />} />
        <StatCard label="المبلغ المستحق" value={approx(iqd(totalAmount.toFixed(2)))} sub={partialTotals ? "مجموعٌ جزئيّ — ضيّق النطاق" : "د.ع — قبل الاستقطاع"} accent="var(--status-active, #16a34a)" icon={<Wallet className="size-5" />} />
        <StatCard label="سجلات بصمة" value={fingerprintCount.toLocaleString("en-US")} sub="مزامنة تلقائية" icon={<Fingerprint className="size-5" />} />
        <StatCard label="إدخالات يدوية" value={manualCount.toLocaleString("en-US")} sub="مُثبَّتة يدوياً" accent="var(--stock-low, #d97706)" icon={<PenLine className="size-5" />} />
      </div>

      <AttendanceSettingsCard />

      {/* نطاقٌ تجاوز سقف المسح الحيّ ⇒ المجاميع جزئية. لا تُعرَض رقماً نهائياً صامتاً. */}
      {partialTotals && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
          <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
          <span className="leading-relaxed">
            <span className="font-medium text-[var(--sem-warn)]">المجاميع جزئية</span> — النطاق المختار
            يتجاوز سقف الاحتساب الحيّ، فالساعات والمبالغ أعلاه وفي ذيل الجدول محسوبةٌ على جزءٍ من
            الصفوف فقط (لذلك سُبقت بعلامة «≥»). ضيّق النطاق أو فلتر بموظفٍ للحصول على رقمٍ نهائيّ.
          </span>
        </div>
      )}

      {/* لقطاتٌ قديمة: السعر المخزَّن يخالف ملفّ الموظف الآن ⇒ المجاميع أعلاه من المخزَّن
          والأعمدة من الملفّ. زرٌّ واحدٌ يُطابقهما — وهو ضروريّ للساعيّ (لقطتُه وعاءُ أجره). */}
      {staleCount > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
          <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
          <div className="flex-1 leading-relaxed">
            <span className="font-medium text-[var(--sem-warn)]">
              {staleCount}{list.data?.staleScanCapped ? "+" : ""} صفّاً بسعرٍ مخزَّنٍ قديم
            </span> —
            في {stalePeriods.length > 1 ? stalePeriods.map(monthLabel).join(" و") : monthLabel(stalePeriods[0] ?? activePeriod)} —
            كُتب قبل ضبط جدول دوام الموظف أو قبل تعديل راتبه.
            العدّ يشمل <span className="font-medium">الشهر كلَّه</span> لا اليوم المعروض ولا الصفحة،
            لأن الإصلاح شهريّ. الأعمدة
            تعرض سعر ملفّ الموظف الآن (وهو ما سيُدفع)، والمخزَّن مشطوبٌ بجانبه.
            <span className="block mt-0.5 text-muted-foreground">
              أشهرُ المسيّرات المُقفَلة مستثناة — لقطتُها هي ما صُرف فعلاً فتبقى كما هي.
            </span>
          </div>
          <Button size="sm" variant="outline" disabled={fixing} onClick={() => void runSmartRecompute(stalePeriods)}>
            <RefreshCw aria-hidden className="size-3.5" />
            {fixing
              ? ACTION_LABELS.processing
              : `إعادة احتساب ${stalePeriods.length > 1 ? `${stalePeriods.length} أشهر` : monthLabel(stalePeriods[0] ?? activePeriod)}`}
          </Button>
        </div>
      )}

      {/* سجل الحضور */}
      <Card>
        <CardHeader>
          <ListToolbar
            title="سجل الحضور"
            count={total}
            loading={list.isLoading}
            search={{ value: f.q, onChange: (v) => setF({ q: v }), placeholder: "بحث باسم الموظف أو اليوم…" }}
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            filters={
              <>
                {/* FilterField يُظهر التسمية بصرياً — aria-label وحده لا يُرى (نمط PR #559/#566). */}
                <FilterField label="الموظف">
                  <AppSelect className="h-9" value={f.employeeId} onValueChange={(next) => setF({ employeeId: next })} aria-label="الموظف">
                    <option value="">كل الموظفين</option>
                    {(opts.data ?? []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
                  </AppSelect>
                </FilterField>
                {/* النطاق — يفتح على «اليوم» بقرار المالك، وبقيةُ التواريخ باستعلامٍ صريح. */}
                <FilterField label="النطاق">
                  <AppSelect className="h-9" value={range} onValueChange={(next) => setF({ range: next })} aria-label="النطاق">
                    {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </AppSelect>
                </FilterField>
                {range === "month" && (
                  <FilterField label="الشهر">
                    <AppSelect className="h-9" value={f.period} onValueChange={(next) => setF({ period: next })} aria-label="الشهر">
                      {recentMonths().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                    </AppSelect>
                  </FilterField>
                )}
                {range === "custom" && (
                  <>
                    <FilterField label="من تاريخ">
                      <Input type="date" className={selectClsSm} value={f.customFrom} max={f.customTo || undefined}
                        onChange={(e) => setF({ customFrom: e.target.value })} aria-label="من تاريخ" />
                    </FilterField>
                    <FilterField label="إلى تاريخ">
                      <Input type="date" className={selectClsSm} value={f.customTo} min={f.customFrom || undefined}
                        onChange={(e) => setF({ customTo: e.target.value })} aria-label="إلى تاريخ" />
                    </FilterField>
                  </>
                )}
                {range !== "month" && range !== "custom" && (
                  <span className="inline-flex items-center h-8 px-2 rounded-md border text-xs tabular-nums text-muted-foreground self-end" dir="ltr">
                    {rangeLabel}
                  </span>
                )}
                <FilterField label="المصدر">
                  <AppSelect className="h-9" value={f.source} onValueChange={(next) => setF({ source: next })} aria-label="المصدر">
                    <option value="">كل المصادر</option>
                    <option value="fingerprint">بصمة</option>
                    <option value="manual">يدوي</option>
                  </AppSelect>
                </FilterField>
                <label className="flex items-center gap-2 h-8 text-sm self-end">
                  <input type="checkbox" className="size-4" checked={f.reviewOnly === "1"} onChange={(e) => setF({ reviewOnly: e.target.checked ? "1" : "" })} />
                  <span className="text-muted-foreground">يحتاج تصحيح فقط</span>
                </label>
              </>
            }
            exportSpec={{
              filename: `الحضور-${rangeLabel.replace(/\s*←\s*/, "_")}`,
              rows,
              // كل الصفحات المطابقة للفلتر **والبحث** — لا الصفحة المعروضة (وإلا خالف الملفُ
              // ما تراه العين بصمت، وهو ما كان يحدث فعلاً عند تجاوز سقف الـ٣٠٠).
              fetchAll: () =>
                fetchAllPaged<AttendanceRow>(
                  (offset, limit) =>
                    utils.attendance.list
                      .fetch({ ...listInput, limit, offset })
                      .then((r) => ({ rows: r.rows as AttendanceRow[], total: r.total })),
                  { pageSize: 500 },
                ),
              columns: [
                { key: "employeeName", header: "الموظف", map: (r) => r.employeeName ?? "" },
                { key: "dayName", header: "اليوم", map: (r) => r.dayName ?? "" },
                { key: "attendanceDate", header: "التاريخ", map: (r) => String(r.attendanceDate ?? "") },
                { key: "hours", header: "صافي الساعات", map: (r) => String(r.hours ?? "") },
                { key: "hourlyRate", header: "سعر الساعة", map: (r) => String(r.hourlyRate ?? "") },
                { key: "amount", header: "أجر اليوم", map: (r) => String(r.amount ?? "") },
                { key: "source", header: "المصدر", map: (r) => (r.source === "fingerprint" ? "بصمة" : "يدوي") },
              ],
            }}
            add={{ label: "إدخال / تصحيح يدوي", onClick: () => { setForm(emptyForm()); setOpen(true); } }}
          />
        </CardHeader>
        <CardContent className="p-0">
          {/*
            * البحث والفلاتر في `ListToolbar` أعلاه (خادميّة، تغذّي الاستعلام) ⇒ `searchable={false}`.
            * والترقيم صار داخل الجدول — `TablePager` المنفصل حُذف كي لا يقفز شريطان بمقدارَين
            * مختلفَين فتُتخطّى سجلّات بصمت.
            * ذيل «الإجمالي» صار `footer` على أعمدة الساعات والأجر (خادميّ لكل المطابق، لا للصفحة).
            */}
          <DataTable<AttendanceRow>
            columns={attendanceColumns}
            data={rows}
            searchable={false}
            externalFiltersActive={activeFilterCount > 0 || f.q.trim() !== ""}
            loading={list.isLoading}
            errorState={{ isError: list.isError, message: "تعذّر تحميل سجلّات الحضور.", onRetry: () => list.refetch() }}
            getRowClassName={(r) => (r.needsReview ? "bg-[var(--sem-warn-bg)]/50" : undefined)}
            serverPagination={{ page, onPageChange: setPage, pageSize: PAGE_SIZE, total, isFetching: list.isFetching }}
            emptyState="لا سجلات حضور في هذه الفترة. غيّر الفلاتر أو سجّل إدخالاً يدوياً."
            emptyFilteredState="لا سجلات مطابقة للبحث أو الفلاتر."
            viewKey="hr-attendance"
          />
        </CardContent>
      </Card>

      {/* نافذة الإدخال والتصحيح اليدوي */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setForm(emptyForm()); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.isEditing ? `تصحيح دوام يوم ${form.attendanceDate}` : "إدخال أو تصحيح حضور يدوي"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="att-emp">الموظف</Label>
              <AppSelect id="att-emp" className="h-9 border-input px-2 text-sm" value={form.employeeId} onValueChange={(next) => setForm({ ...form, employeeId: next })}>
                <option value="">— اختر الموظف —</option>
                {(opts.data ?? []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
              </AppSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="att-date">التاريخ</Label>
                <Input id="att-date" type="date" dir="ltr" value={form.attendanceDate} onChange={(e) => setForm({ ...form, attendanceDate: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>حالة اليوم</Label>
                <AppSelect
                  className="h-9 border-input px-2 text-sm"
                  value={form.status}
                  onValueChange={(v) => {
                    const nextStatus = v as DayStatus;
                    if (nextStatus === "ABSENT" || nextStatus === "LEAVE") {
                      setForm({ ...form, status: nextStatus, hours: "0", lateDeductionMinutes: "", breakMinutes: "" });
                    } else if (form.mode === "split") {
                      const res = computeSessionsSummary(form.sessions);
                      setForm({ ...form, status: nextStatus, hours: !res.violation ? res.totalHours.toFixed(2) : !(Number(form.hours) > 0) ? "8" : form.hours });
                    } else {
                      const auto = spanHours(form.checkIn, form.checkOut, { crossMidnight: form.crossMidnight });
                      const brk = Math.max(0, Number(form.breakMinutes) || 0);
                      const net = auto != null ? Math.max(0, Math.round((auto - brk / 60) * 100) / 100) : null;
                      setForm({ ...form, status: nextStatus, hours: net != null ? net.toFixed(2) : !(Number(form.hours) > 0) ? "8" : form.hours });
                    }
                  }}
                >
                  <option value="PRESENT">حضور</option>
                  <option value="LATE">تأخير</option>
                  <option value="ABSENT">غياب (٠ ساعة)</option>
                  <option value="LEAVE">إجازة مدفوعة</option>
                </AppSelect>
              </div>
            </div>

            {isPaidFormStatus && (
              <div className="space-y-1">
                <Label>نمط دوام اليوم</Label>
                <div className="grid grid-cols-2 gap-1.5 rounded-md border bg-muted/30 p-1">
                  <button
                    type="button"
                    className={`rounded px-2 py-1.5 text-xs font-medium transition-colors ${form.mode === "single" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => {
                      const auto = spanHours(form.checkIn, form.checkOut, { crossMidnight: form.crossMidnight });
                      const rawBrk = Math.max(0, Number(form.breakMinutes) || 0);
                      const brk = auto != null && rawBrk / 60 >= auto ? 0 : rawBrk;
                      const net = auto != null ? Math.max(0, Math.round((auto - brk / 60) * 100) / 100) : null;
                      setForm((cur) => ({ ...cur, mode: "single", breakMinutes: brk > 0 ? String(brk) : "", hours: net != null ? net.toFixed(2) : cur.hours }));
                    }}
                  >
                    فترة واحدة (مع خيار استراحة/زمنية)
                  </button>
                  <button
                    type="button"
                    className={`rounded px-2 py-1.5 text-xs font-medium transition-colors ${form.mode === "split" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => {
                      setForm((cur) => {
                        const existing = computeSessionsSummary(cur.sessions);
                        const keep = cur.sessions.length >= 2 && existing.firstCheckIn === cur.checkIn && (existing.lastCheckOut ?? "") === cur.checkOut && (!existing.violation || existing.hasOpenSession);
                        const nextSessions = keep ? cur.sessions : buildDefaultSplitSessions(cur.checkIn, cur.checkOut, { crossMidnight: cur.crossMidnight });
                        const res = computeSessionsSummary(nextSessions);
                        return {
                          ...cur, mode: "split", sessions: nextSessions,
                          hours: !res.violation ? res.totalHours.toFixed(2) : cur.hours,
                          checkIn: res.firstCheckIn || cur.checkIn, checkOut: res.lastCheckOut || cur.checkOut,
                          breakMinutes: res.breakMinutes > 0 ? String(res.breakMinutes) : "", crossMidnight: res.lastCrossMidnight,
                        };
                      });
                    }}
                  >
                    دوام مجزّأ (فترتان أو أكثر — استراحة والعودة)
                  </button>
                </div>
              </div>
            )}

            {form.mode === "single" ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="att-in">وقت الدخول</Label>
                    <Input id="att-in" type="time" dir="ltr" value={form.checkIn} onChange={(e) => setFormTime({ checkIn: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="att-out">وقت الخروج</Label>
                    <Input id="att-out" type="time" dir="ltr" value={form.checkOut} onChange={(e) => setFormTime({ checkOut: e.target.value })} />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" className="size-3.5" checked={form.crossMidnight} onChange={(e) => setFormTime({ crossMidnight: e.target.checked })} />
                  <span>انصراف بعد منتصف الليل (اليوم التالي +1)</span>
                </label>

                {isPaidFormStatus && (
                  <div className="space-y-1 rounded-md border bg-muted/20 p-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <Label htmlFor="att-break" className="text-xs">استراحة / زمنية مستقطعة خلال الدوام (دقائق — اختياري)</Label>
                      <div className="flex items-center gap-1">
                        {[{ label: "بلا", val: "" }, { label: "٣٠ د", val: "30" }, { label: "١ س", val: "60" }, { label: "٢ س", val: "120" }].map((preset) => (
                          <button
                            key={preset.label} type="button"
                            className={`rounded border px-1.5 py-0.5 text-[11px] ${form.breakMinutes === preset.val ? "border-primary bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}
                            onClick={() => applyBreakMinutes(preset.val)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <Input
                      id="att-break" type="number" min={0} max={720} step="15" dir="ltr"
                      placeholder="0 (مثلاً 60 لاستراحة أو زمنية ساعة واحدة)"
                      value={form.breakMinutes} onChange={(e) => applyBreakMinutes(e.target.value)}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">فترات الدوام في نفس اليوم (دخول وخروج لكل فترة)</span>
                  {form.sessions.length < 4 && (
                    <Button type="button" size="sm" variant="outline" className="h-7 text-xs px-2" onClick={() => applySplitSessions([...form.sessions, suggestNextSplitSession(form.sessions)])}>
                      <Plus aria-hidden className="size-3" /> إضافة فترة
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {form.sessions.map((s, idx) => (
                    <div key={idx} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
                      <span className="text-xs text-muted-foreground">فترة {idx + 1}:</span>
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-muted-foreground">من</span>
                        <Input type="time" dir="ltr" className="h-8 text-xs" value={s.checkIn ?? ""} onChange={(e) => applySplitSessions(form.sessions.map((item, i) => (i === idx ? { ...item, checkIn: e.target.value } : item)))} />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-muted-foreground">إلى</span>
                        <Input type="time" dir="ltr" className="h-8 text-xs" value={s.checkOut ?? ""} onChange={(e) => { const val = e.target.value; applySplitSessions(form.sessions.map((item, i) => (i === idx ? { ...item, checkOut: val, crossMidnight: Boolean(item.checkIn && val && val <= item.checkIn) } : item))); }} />
                      </div>
                      {form.sessions.length > 2 ? (
                        <button type="button" className="text-muted-foreground hover:text-[var(--sem-neg)] p-1" onClick={() => applySplitSessions(form.sessions.filter((_, i) => i !== idx))} title="حذف الفترة">
                          <Trash2 aria-hidden className="size-3.5" />
                        </button>
                      ) : <span className="w-5" />}
                    </div>
                  ))}
                </div>
                {splitSummary && !splitSummary.violation && (
                  <div className="rounded bg-background p-2 text-xs flex items-center justify-between flex-wrap gap-2 border">
                    <span>مجموع العمل الصافي: <strong dir="ltr" className="tabular-nums">{splitSummary.totalHours}</strong> ساعة</span>
                    <span className="text-muted-foreground">الاستراحة / الفاصل بين الفترات: <strong>{formatDurationArabic(splitSummary.breakMinutes)}</strong></span>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="att-hours">صافي الساعات المحتسَبة (قبل خصم التأخير)</Label>
                {form.mode === "single" && formSpan != null && isPaidFormStatus && (() => {
                  const brk = Math.max(0, Number(form.breakMinutes) || 0);
                  const expectedNet = Math.max(0, Math.round((formSpan - brk / 60) * 100) / 100);
                  return Math.abs(Number(form.hours || 0) - expectedNet) > 0.01 ? (
                    <button type="button" className="text-xs text-primary hover:underline" onClick={() => setForm({ ...form, hours: expectedNet.toFixed(2) })}>
                      حساب تلقائي ({expectedNet.toFixed(2)} س)
                    </button>
                  ) : null;
                })()}
              </div>
              <Input
                id="att-hours" type="number" min={0} max={24} step="0.25" dir="ltr" inputMode="decimal"
                disabled={!isPaidFormStatus || form.mode === "split"} value={form.hours}
                onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="8"
              />
              {formError ? (
                <p className="text-xs leading-relaxed text-[var(--sem-neg)]">{formError}</p>
              ) : (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {!isPaidFormStatus
                    ? "الغياب والإجازة يُسجَّلان بصفر ساعات عمل فعلية (والإجازة المدفوعة تُعوَّض في كشف الراتب)."
                    : form.mode === "split"
                      ? "تُحسب الساعات تلقائياً بجمع فترات الدوام واستبعاد فترة الاستراحة/الزمنية بينها."
                      : formSpan != null
                        ? "تُحسب تلقائياً من وقت الدخول والخروج مطروحاً منها الاستراحة/الزمنية — أو عدّلها يدوياً لتثبيت ساعات مخصّصة."
                        : "أدخِل وقتَي الدخول والخروج للحساب التلقائي، أو أدخِل الساعات يدوياً مباشرةً."}
                </p>
              )}
            </div>
            {isPaidFormStatus && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="att-late">خصم تأخير يدوي (دقائق — اختياري)</Label>
                  <Input
                    id="att-late" type="number" min={0} max={720} step="5" dir="ltr" placeholder="0"
                    value={form.lateDeductionMinutes}
                    onChange={(e) => {
                      const nextVal = e.target.value;
                      const hadDeduction = Number(form.lateDeductionMinutes) > 0;
                      const hasDeduction = Number(nextVal) > 0;
                      setForm({ ...form, lateDeductionMinutes: nextVal, status: hadDeduction && !hasDeduction && form.status === "LATE" ? "PRESENT" : form.status });
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="att-notes">ملاحظة</Label>
                  <Input id="att-notes" value={form.notes} placeholder="سبب الإدخال أو التعديل اليدوي…" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
              </div>
            )}
            {isPaidFormStatus && Number(form.lateDeductionMinutes) > 0 && (
              <p className="text-xs text-[var(--sem-warn)]">
                سيُخصم {Number(form.lateDeductionMinutes)} دقيقة ({(Number(form.lateDeductionMinutes) / 60).toFixed(2)} ساعة) من الساعات المسجَّلة ليصبح الصافي{" "}
                {Math.max(0, (Number(form.hours) || 0) - Number(form.lateDeductionMinutes) / 60).toFixed(2)} ساعة.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              الإدخال أو التصحيح اليدوي يُثبّت اليوم ويرفع وسم المراجعة، ولا يطمسه تحديث البصمات التلقائي لاحقاً.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            {/* نصّ الانتظار المجرّد هنا كان يخصّ فعلَ حفظ الحضور ⇒ مفتاح الحفظ الموحّد. */}
            <Button disabled={record.isPending || !!formError} onClick={submit}>
              {record.isPending ? ACTION_LABELS.saving : form.isEditing ? "حفظ التصحيح" : "حفظ الحضور"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * إعداد الوردية الليلية العابرة منتصف الليل — **معطَّل افتراضياً** بقرار المالك
 * (يحدث نادراً في المطبعة). بلا تفعيله تُسجَّل وردية 22:00→06:00 يومين ببصمة واحدة
 * لكلٍّ ⇒ صفر ساعات وصفر أجر لليلة عمل كاملة؛ ومع تفعيله تُغلق بصمةُ الفجر وردية أمس.
 * تغييره لا يُعيد حساب الماضي (مسيّرات سابقة قد تكون بُنيت على الأرقام القديمة).
 */
function AttendanceSettingsCard() {
  const utils = trpc.useUtils();
  const q = trpc.attendance.settings.useQuery();
  const [open, setOpen] = useState(false);
  const s = q.data;
  const [payOn, setPayOn] = useState(false);
  const [payFrom, setPayFrom] = useState("");
  const [maxDaily, setMaxDaily] = useState(12);
  const [nightOn, setNightOn] = useState(false);
  const [nightCutoff, setNightCutoff] = useState(8);

  useEffect(() => {
    if (!open || !s) return;
    setPayOn(!!s.attendancePayEnabled);
    setPayFrom(s.attendancePayFrom ? String(s.attendancePayFrom).slice(0, 10) : "");
    setMaxDaily(Number(s.maxDailyHours ?? 12));
    setNightOn(!!s.nightShiftEnabled);
    setNightCutoff(Number(s.nightShiftCutoffHour ?? 8));
  }, [open, s]);

  const save = trpc.attendance.updateSettings.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظت إعدادات الاحتساب");
      setOpen(false);
      await utils.attendance.settings.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <>
      <Card>
        <CardContent className="p-3 flex items-center justify-between gap-3 flex-wrap text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <Clock className="size-4 text-muted-foreground" />
            <span>الأجر بالحضور:</span>
            <span className={s?.attendancePayEnabled ? "font-medium text-[var(--status-active,#16a34a)]" : "text-muted-foreground"}>
              {q.isLoading ? "…" : s?.attendancePayEnabled ? `مفعَّل من ${String(s.attendancePayFrom ?? "").slice(0, 10)}` : "معطَّل"}
            </span>
            <span className="text-muted-foreground">·</span>
            <span>سقف ساعات اليوم:</span>
            <span className="font-medium tabular-nums" dir="ltr">{q.isLoading ? "…" : `${Number(s?.maxDailyHours ?? 12)} ساعة`}</span>
            <span className="text-muted-foreground">·</span>
            <span>الوردية الليلية:</span>
            <span className={s?.nightShiftEnabled ? "font-medium text-[var(--status-active,#16a34a)]" : "text-muted-foreground"}>
              {q.isLoading ? "…" : s?.nightShiftEnabled ? `مفعَّلة — الفصل ${Number(s.nightShiftCutoffHour ?? 8)}:00` : "معطَّلة"}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>إعدادات الاحتساب</Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>إعدادات احتساب الحضور والأجر</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground rounded-md border p-2 leading-relaxed">
              ساعات كل يوم وسعر ساعته تُضبط <span className="font-medium">في بطاقة كل موظف</span> — لا هنا،
              فلكلٍّ جدولُه. هذه الشاشة للإعدادات العامّة التي لا تخصّ موظفاً بعينه.
            </p>

            <div className="rounded-md border p-3 space-y-2">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="size-4 mt-0.5" checked={payOn} onChange={(e) => setPayOn(e.target.checked)} />
                <span>
                  <span className="font-medium">الأجر بالحضور (للموظفين الشهريّين)</span>
                  <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    أجر اليوم = صافي ساعات العمل × سعر ساعة اليوم، والمستحقّ = مجموع أيام الشهر. الغياب بلا أجر،
                    والإجازة المدفوعة يوم دوامٍ كامل، والساعات التي تزيد على ساعات جدول الموظف اليومية تُحسب عملًا إضافياً (أوفر تايم).
                  </span>
                </span>
              </label>
              <div className="space-y-1">
                <Label htmlFor="ap-from">يسري من تاريخ</Label>
                <Input id="ap-from" type="date" dir="ltr" value={payFrom} disabled={!payOn} onChange={(e) => setPayFrom(e.target.value)} />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  إلزاميّ: ما قبل هذا التاريخ يُعامَل دواماً مدفوعاً كاملاً. بدونه تُحتسب أشهرٌ سبقت تشغيل
                  جهاز الحضور — ولا بيانات فيها — غياباً كاملاً فتُصفَّر رواتبها.
                </p>
              </div>
            </div>

            <div className="rounded-md border p-3 space-y-1">
              <Label htmlFor="max-daily">حارس الساعات — السقف الأعلى لليوم الواحد</Label>
              <Input id="max-daily" type="number" min={1} max={24} step="0.5" dir="ltr" value={maxDaily} onChange={(e) => setMaxDaily(Number(e.target.value))} />
              <p className="text-xs text-muted-foreground leading-relaxed">
                يومٌ تتجاوز بصماتُه هذا السقف يُقصّ عنده ويُوسَم «يحتاج تصحيح». ومعه تعمل تنبيهاتٌ أخرى:
                خروجٌ قبل دخول · بصمة مكرّرة بأقلّ من ٥ دقائق · يومٌ أقلّ من نصف دوام اليوم · بصمة خروجٍ ناقصة.
                كلُّها تنبيهٌ للمراجعة لا منع — القيمة تبقى وتظهر في قائمة «يحتاج تصحيح».
              </p>
            </div>

            <div className="rounded-md border p-3 space-y-2">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="size-4 mt-0.5" checked={nightOn} onChange={(e) => setNightOn(e.target.checked)} />
                <span>
                  <span className="font-medium">الوردية الليلية العابرة منتصف الليل</span>
                  <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    بدونها تُسجَّل وردية ٢٢:٠٠ ← ٠٦:٠٠ يومين ببصمةٍ واحدة لكلٍّ ⇒ صفر ساعات وصفر أجر
                    لليلة عملٍ كاملة. ومعها تُغلق بصمةُ الفجر وردية أمس ولا تفتح يوماً جديداً.
                  </span>
                </span>
              </label>
              <div className="space-y-1">
                <Label htmlFor="night-cutoff">ساعة الفصل الصباحية</Label>
                <Input
                  id="night-cutoff" type="number" min={0} max={23} step="1" dir="ltr"
                  value={nightCutoff} disabled={!nightOn}
                  onChange={(e) => setNightCutoff(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  بصمةٌ قبل هذه الساعة تخصّ وردية اليوم السابق. اضبطها بعد آخر انصرافٍ ليليّ متوقَّع
                  وقبل أوّل دخولٍ صباحيّ — الافتراضي ٨ صباحاً.
                </p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground border-t pt-2">
              التغيير لا يُعيد حساب أيام مسجَّلة سابقاً — يسري على ما يصل بعده.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate({
              attendancePayEnabled: payOn,
              attendancePayFrom: payFrom || null,
              maxDailyHours: maxDaily,
              nightShiftEnabled: nightOn,
              nightShiftCutoffHour: nightCutoff,
            })}>
              {save.isPending ? ACTION_LABELS.saving : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
