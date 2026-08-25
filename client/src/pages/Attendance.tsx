import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FilterField, ListToolbar } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { WEEK_DAYS } from "@shared/hr";
import { Clock, Fingerprint, Moon, PenLine, RefreshCw, TriangleAlert, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { selectClsSm } from "@/lib/ui/formStyles";

type AttendanceRow = RouterOutputs["attendance"]["list"]["rows"][number];

/** حجم صفحة السجلّ — الخادم يُرقّم (سقفه ٥٠٠). */
const PAGE_SIZE = 50;


/** الشهر الحالي بصيغة "YYYY-MM". */
const currentMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

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

const emptyForm = () => ({ employeeId: "", attendanceDate: today(), hours: "", checkIn: "", checkOut: "" });

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

  /** يُصلح **كلّ** شهرٍ فيه لقطاتٌ قديمة — لا شهرَ نهاية المدى وحده. */
  async function fixStalePeriods() {
    if (!stalePeriods.length || fixing) return;
    setFixing(true);
    try {
      let updated = 0;
      for (const p of stalePeriods) {
        const r = await recompute.mutateAsync({ period: p, employeeId: f.employeeId ? Number(f.employeeId) : undefined });
        updated += r.updated;
      }
      notify.ok(updated > 0 ? `أُعيد احتساب ${updated} صفّاً في ${stalePeriods.length} شهراً` : "كل الأسعار مطابقة لملفّات الموظفين");
      await Promise.all([utils.attendance.list.invalidate(), utils.attendance.summary.invalidate()]);
    } catch {
      // notify.err عُرِضت في onError — نُبطّل الكاش كي يظهر ما نجح إصلاحُه قبل الفشل.
      await Promise.all([utils.attendance.list.invalidate(), utils.attendance.summary.invalidate()]);
    } finally {
      setFixing(false);
    }
  }

  const record = trpc.attendance.record.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسجيل الحضور");
      setOpen(false);
      setForm(emptyForm());
      // البطاقات صارت خادمية ⇒ تُبطَّل مع القائمة وإلا بقيت مجاميعها قديمة بعد الإدخال.
      await Promise.all([utils.attendance.list.invalidate(), utils.attendance.summary.invalidate()]);
    },
    onError: (e) => notify.err(e),
  });

  function submit() {
    if (!form.employeeId) return notify.warn("اختر الموظف");
    const hours = Number(form.hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) return notify.warn("أدخل عدد ساعات صحيح (٠–٢٤)");
    record.mutate({
      employeeId: Number(form.employeeId),
      attendanceDate: form.attendanceDate,
      hours,
      checkIn: form.checkIn.trim() || undefined,
      checkOut: form.checkOut.trim() || undefined,
      source: "manual",
    });
  }

  return (
    <div className="space-y-4">
      {/* الترويسة */}
      <PageHeader
        title="الحضور والانصراف"
        description="نظام احتساب بالساعة — أجر اليوم = ساعات الحضور × سعر ساعة ذلك اليوم. المصدر: أجهزة البصمة."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
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
        <StatCard label={`إجمالي ساعات ${rangeLabel}`} value={approx(totalHours.toNumber().toLocaleString("en-US"))} sub={partialTotals ? "مجموعٌ جزئيّ — ضيّق النطاق" : "حسب النطاق المختار"} icon={<Clock className="size-5" />} />
        <StatCard label="المبلغ المستحق" value={approx(iqd(totalAmount.toFixed(2)))} sub={partialTotals ? "مجموعٌ جزئيّ — ضيّق النطاق" : "د.ع — قبل الاستقطاع"} accent="var(--status-active, #16a34a)" icon={<Wallet className="size-5" />} />
        <StatCard label="سجلات بصمة" value={fingerprintCount.toLocaleString("en-US")} sub="مزامنة تلقائية" icon={<Fingerprint className="size-5" />} />
        <StatCard label="إدخالات يدوية" value={manualCount.toLocaleString("en-US")} sub="تحتاج توثيقاً" accent="var(--stock-low, #d97706)" icon={<PenLine className="size-5" />} />
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
          <Button size="sm" variant="outline" disabled={fixing} onClick={() => void fixStalePeriods()}>
            <RefreshCw aria-hidden className="size-3.5" />
            {fixing
              ? "جارٍ…"
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
                  <select className={selectClsSm} value={f.employeeId} onChange={(e) => setF({ employeeId: e.target.value })} aria-label="الموظف">
                    <option value="">كل الموظفين</option>
                    {(opts.data ?? []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
                  </select>
                </FilterField>
                {/* النطاق — يفتح على «اليوم» بقرار المالك، وبقيةُ التواريخ باستعلامٍ صريح. */}
                <FilterField label="النطاق">
                  <select className={selectClsSm} value={range} onChange={(e) => setF({ range: e.target.value })} aria-label="النطاق">
                    {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </FilterField>
                {range === "month" && (
                  <FilterField label="الشهر">
                    <select className={selectClsSm} value={f.period} onChange={(e) => setF({ period: e.target.value })} aria-label="الشهر">
                      {recentMonths().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                    </select>
                  </FilterField>
                )}
                {range === "custom" && (
                  <>
                    <FilterField label="من تاريخ">
                      <input type="date" className={selectClsSm} dir="ltr" value={f.customFrom} max={f.customTo || undefined}
                        onChange={(e) => setF({ customFrom: e.target.value })} aria-label="من تاريخ" />
                    </FilterField>
                    <FilterField label="إلى تاريخ">
                      <input type="date" className={selectClsSm} dir="ltr" value={f.customTo} min={f.customFrom || undefined}
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
                  <select className={selectClsSm} value={f.source} onChange={(e) => setF({ source: e.target.value })} aria-label="المصدر">
                    <option value="">كل المصادر</option>
                    <option value="fingerprint">بصمة</option>
                    <option value="manual">يدوي</option>
                  </select>
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
                { key: "hours", header: "ساعات", map: (r) => String(r.hours ?? "") },
                { key: "hourlyRate", header: "سعر الساعة", map: (r) => String(r.hourlyRate ?? "") },
                { key: "amount", header: "أجر اليوم", map: (r) => String(r.amount ?? "") },
                { key: "source", header: "المصدر", map: (r) => (r.source === "fingerprint" ? "بصمة" : "يدوي") },
              ],
            }}
            add={{ label: "إدخال يدوي", onClick: () => { setForm(emptyForm()); setOpen(true); } }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2.5">الموظف</th>
                  <th className="p-2.5">اليوم</th>
                  <th className="p-2.5 text-center">التاريخ</th>
                  <th className="p-2.5 text-center">دخول</th>
                  <th className="p-2.5 text-center">خروج</th>
                  <th className="p-2.5 text-center">ساعات</th>
                  <th className="p-2.5 text-right">سعر الساعة</th>
                  <th className="p-2.5 text-right">أجر اليوم</th>
                  <th className="p-2.5 text-center">المصدر</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const weekend = r.dayName === "الجمعة" || r.dayName === "السبت";
                  return (
                    <tr key={r.id} className={`border-t hover:bg-accent/40 ${r.needsReview ? "bg-[var(--sem-warn-bg)]/50" : ""}`}>
                      <td className="p-2.5">
                        <button onClick={() => navigate(`/hr/employees/${r.employeeId}`)} className="flex items-center gap-2 hover:text-primary">
                          <EmpAvatar name={r.employeeName} color={r.colorTag} photoUrl={r.photoUrl} sizePx={28} />
                          <span className="text-[13px] font-medium">{r.employeeName}</span>
                        </button>
                        {/* يومٌ ينقصه إغلاق: لا يُخمَّن أجره — يُصحَّح يدوياً قبل إغلاق الشهر. */}
                        {r.needsReview && (
                          <div
                            className="mt-1 inline-flex items-center gap-1 rounded-full border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[10px] text-[var(--sem-warn)]"
                            title={r.reviewReason ?? "ينقص تسجيل خروج"}
                          >
                            <TriangleAlert aria-hidden className="size-3" />
                            يحتاج تصحيح
                          </div>
                        )}
                      </td>
                      <td className="p-2.5 text-[13px]">{r.dayName}</td>
                      <td className="p-2.5 text-center text-xs tabular-nums" dir="ltr">{r.attendanceDate}</td>
                      <td className="p-2.5 text-center tabular-nums" dir="ltr">{r.checkIn ? new Date(r.checkIn).toISOString().slice(11, 16) : "—"}</td>
                      <td className="p-2.5 text-center tabular-nums" dir="ltr">{r.checkOut ? new Date(r.checkOut).toISOString().slice(11, 16) : "—"}</td>
                      <td className="p-2.5 text-center tabular-nums">{Number(r.hours ?? 0)}</td>
                      {/* السعر مُشتقٌّ من ملفّ الموظف الآن — والمخزَّن المخالف يُعرَض مشطوباً لا يُخفى. */}
                      <td className={`p-2.5 text-right tabular-nums ${weekend ? "text-[var(--stock-low)] font-medium" : ""}`} dir="ltr">
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
                      </td>
                      <td className="p-2.5 text-right tabular-nums font-semibold" dir="ltr">
                        {iqd(r.amount)}
                        {r.rateStale && (
                          <span className="block text-[10px] font-normal text-[var(--sem-warn)] line-through">{iqd(r.storedAmount)}</span>
                        )}
                      </td>
                      <td className="p-2.5 text-center">
                        {r.source === "fingerprint" ? (
                          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Fingerprint className="size-3.5" /> بصمة</span>
                        ) : (
                          <span className="text-[11px] text-[var(--stock-low)] inline-flex items-center gap-1"><PenLine className="size-3.5" /> يدوي</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {list.isLoading && (
                  <tr><td colSpan={9}><LoadingState /></td></tr>
                )}
                {list.isError && (
                  <tr><td colSpan={9}><ErrorState message="تعذّر تحميل سجلّات الحضور." onRetry={() => list.refetch()} /></td></tr>
                )}
                {!list.isLoading && !list.isError && rows.length === 0 && (
                  <TableEmptyRow colSpan={9} message={f.q ? "لا سجلات مطابقة للبحث." : "لا سجلات حضور في هذه الفترة. غيّر الفلاتر أو سجّل إدخالاً يدوياً."} />
                )}
                {rows.length > 0 && (
                  <tr className="border-t-2 border-border bg-muted/40 font-bold">
                    <td className="p-2.5" colSpan={5}>الإجمالي</td>
                    <td className="p-2.5 text-center tabular-nums">{approx(visHours.toNumber().toLocaleString("en-US"))}</td>
                    <td></td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{approx(iqd(visAmount.toFixed(2)))}</td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
        <TablePager
          page={page}
          onPageChange={setPage}
          pageSize={PAGE_SIZE}
          rowsOnPage={rows.length}
          total={total}
          isLoading={list.isFetching}
        />
      </Card>

      {/* نافذة الإدخال اليدوي */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setForm(emptyForm()); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>إدخال حضور يدوي</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="att-emp">الموظف</Label>
              <select id="att-emp" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                <option value="">— اختر موظفاً بالساعة —</option>
                {(opts.data ?? []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="att-date">التاريخ</Label>
                <Input id="att-date" type="date" dir="ltr" value={form.attendanceDate} onChange={(e) => setForm({ ...form, attendanceDate: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="att-hours">عدد الساعات</Label>
                <Input id="att-hours" type="number" min={0} max={24} step="0.25" dir="ltr" inputMode="decimal" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="8" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="att-in">وقت الدخول</Label>
                <Input id="att-in" type="time" dir="ltr" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="att-out">وقت الخروج</Label>
                <Input id="att-out" type="time" dir="ltr" value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>المصدر</Label>
              <div className="flex h-9 items-center rounded-md border border-input px-3 text-sm text-muted-foreground">
                يدوي — سجلات البصمة تأتي من مزامنة الجهاز فقط
              </div>
            </div>
            <p className="text-xs text-muted-foreground">أجر اليوم يُحتسب آلياً من ساعات الحضور وسعر ساعة ذلك اليوم في ملف الموظف.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button disabled={record.isPending} onClick={submit}>{record.isPending ? "جارٍ…" : "حفظ الحضور"}</Button>
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
            <span>سقف اليوم:</span>
            <span className="font-medium tabular-nums" dir="ltr">{q.isLoading ? "…" : `${Number(s?.maxDailyHours ?? 12)} ساعة`}</span>
            <span className="text-muted-foreground">·</span>
            <span>الوردية الليلية:</span>
            <span className={s?.nightShiftEnabled ? "font-medium text-[var(--status-active,#16a34a)]" : "text-muted-foreground"}>
              {q.isLoading ? "…" : s?.nightShiftEnabled ? `مفعَّلة — الفصل ${Number(s.nightShiftCutoffHour ?? 8)}:00` : "معطَّلة"}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>تعديل</Button>
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
                    أجر اليوم = ساعاته المحتسَبة × سعر ساعته، والمستحقّ = مجموع أيام الشهر. الغياب بلا أجر،
                    والإجازة المدفوعة يوم دوامٍ كامل، والساعات فوق المقرَّر أوفر تايم.
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
              <Label htmlFor="max-daily">حارس الساعات — سقف اليوم الواحد</Label>
              <Input id="max-daily" type="number" min={1} max={24} step="0.5" dir="ltr" value={maxDaily} onChange={(e) => setMaxDaily(Number(e.target.value))} />
              <p className="text-xs text-muted-foreground leading-relaxed">
                يومٌ تتجاوز بصماتُه هذا السقف يُقصّ عنده ويُوسَم «يحتاج تصحيح». ومعه تعمل حرّاسٌ أخرى:
                خروجٌ قبل دخول · بصمة مكرّرة بأقلّ من ٥ دقائق · يومٌ أقلّ من نصف المقرَّر · بصمة خروجٍ ناقصة.
                كلُّها وسمٌ لا منع — القيمة تبقى وتظهر في طابور التصحيح.
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
                <Label htmlFor="night-cutoff">ساعة الفصل</Label>
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
              {save.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
