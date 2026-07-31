import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ListToolbar } from "@/components/list";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { WEEK_DAYS } from "@shared/hr";
import { Clock, Fingerprint, Moon, PenLine, TriangleAlert, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

type AttendanceRow = RouterOutputs["attendance"]["list"]["rows"][number];

/** حجم صفحة السجلّ — الخادم يُرقّم (سقفه ٥٠٠). */
const PAGE_SIZE = 50;

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

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

export default function Attendance() {
  const [, navigate] = useLocation();
  const [employeeId, setEmployeeId] = useState("");
  const [period, setPeriod] = useState(currentMonth());
  const [source, setSource] = useState("");
  // طابور التصحيح: أيام ينقصها إغلاق (نُسيت بصمة الخروج) — تُصحَّح قبل إغلاق الشهر.
  const [reviewOnly, setReviewOnly] = useState(false);
  const [query, setQuery] = useState("");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());

  const utils = trpc.useUtils();
  const opts = trpc.attendance.formOptions.useQuery();

  // فلتر البطاقات (بلا بحث): البطاقات مؤشّرُ الشهر/الفلتر — سلوك محفوظ كما كان.
  const filterInput = useMemo(
    () => ({
      employeeId: employeeId ? Number(employeeId) : undefined,
      period: period || undefined,
      source: (source || undefined) as "fingerprint" | "manual" | undefined,
      needsReviewOnly: reviewOnly || undefined,
    }),
    [employeeId, period, source, reviewOnly],
  );

  // البحث خادميّ الآن (اسم/تاريخ/يوم): كان يُصفّي الصفوف المُحمَّلة وحدها (سقف ٣٠٠) ⇒ يقول
  // «لا نتائج» عن سجلٍّ موجود خارج السقف. debounce ليكتب المستخدم بلا طلبٍ لكل حرف.
  const dq = useDebouncedValue(query.trim(), 300);
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

  // مجاميع ذيل الجدول تتبع المطابق للفلتر **والبحث** (لا الصفحة) — خادمية بنفس شروط الصفوف.
  const visHours = D(list.data?.totals.hours ?? 0);
  const visAmount = D(list.data?.totals.amount ?? 0);

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
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/devices"><Fingerprint className="size-4" /> أجهزة البصمة</Link>
          </Button>
        }
      />

      {/* مؤشرات */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label={`إجمالي ساعات ${monthLabel(period)}`} value={totalHours.toNumber().toLocaleString("en-US")} sub="للموظفين بالساعة" icon={<Clock className="size-5" />} />
        <StatCard label="المبلغ المستحق" value={iqd(totalAmount.toFixed(2))} sub="د.ع — قبل الاستقطاع" accent="var(--status-active, #16a34a)" icon={<Wallet className="size-5" />} />
        <StatCard label="سجلات بصمة" value={fingerprintCount.toLocaleString("en-US")} sub="مزامنة تلقائية" icon={<Fingerprint className="size-5" />} />
        <StatCard label="إدخالات يدوية" value={manualCount.toLocaleString("en-US")} sub="تحتاج توثيقاً" accent="var(--stock-low, #d97706)" icon={<PenLine className="size-5" />} />
      </div>

      <NightShiftSettingsCard />

      {/* سجل الحضور */}
      <Card>
        <CardHeader>
          <ListToolbar
            title="سجل الحضور"
            count={total}
            loading={list.isLoading}
            search={{ value: query, onChange: setQuery, placeholder: "بحث باسم الموظف أو اليوم…" }}
            filters={
              <>
                <select className={selectCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="الموظف">
                  <option value="">كل الموظفين بالساعة</option>
                  {(opts.data ?? []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
                </select>
                <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="الشهر">
                  {recentMonths().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
                <select className={selectCls} value={source} onChange={(e) => setSource(e.target.value)} aria-label="المصدر">
                  <option value="">كل المصادر</option>
                  <option value="fingerprint">بصمة</option>
                  <option value="manual">يدوي</option>
                </select>
                <label className="flex items-center gap-2 h-8 text-sm">
                  <input type="checkbox" className="size-4" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} />
                  <span className="text-muted-foreground">يحتاج تصحيح فقط</span>
                </label>
              </>
            }
            exportSpec={{
              filename: `الحضور-${period}`,
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
                      <td className={`p-2.5 text-right tabular-nums ${weekend ? "text-[var(--stock-low)] font-medium" : ""}`} dir="ltr">{iqd(r.hourlyRate)}</td>
                      <td className="p-2.5 text-right tabular-nums font-semibold" dir="ltr">{iqd(r.amount)}</td>
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
                  <TableEmptyRow colSpan={9} message={query ? "لا سجلات مطابقة للبحث." : "لا سجلات حضور في هذه الفترة. غيّر الفلاتر أو سجّل إدخالاً يدوياً."} />
                )}
                {rows.length > 0 && (
                  <tr className="border-t-2 border-border bg-muted/40 font-bold">
                    <td className="p-2.5" colSpan={5}>الإجمالي</td>
                    <td className="p-2.5 text-center tabular-nums">{visHours.toNumber().toLocaleString("en-US")}</td>
                    <td></td>
                    <td className="p-2.5 text-right tabular-nums" dir="ltr">{iqd(visAmount.toFixed(2))}</td>
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
function NightShiftSettingsCard() {
  const utils = trpc.useUtils();
  const q = trpc.attendance.settings.useQuery();
  const [open, setOpen] = useState(false);
  const save = trpc.attendance.updateSettings.useMutation({
    onSuccess: async () => { notify.ok("حُفظت إعدادات احتساب الحضور"); await utils.attendance.settings.invalidate(); setOpen(false); },
    onError: (e) => notify.err(e),
  });
  const s = q.data;
  const [enabled, setEnabled] = useState(false);
  const [cutoff, setCutoff] = useState(8);
  const [payOn, setPayOn] = useState(false);
  const [payFrom, setPayFrom] = useState("");
  const [dailyHours, setDailyHours] = useState(8);
  const [restDays, setRestDays] = useState<string[]>(["الجمعة"]);
  useEffect(() => {
    if (!open || !s) return;
    setEnabled(!!s.nightShiftEnabled);
    setCutoff(Number(s.nightShiftCutoffHour ?? 8));
    setPayOn(!!s.attendancePayEnabled);
    setPayFrom(s.attendancePayFrom ? String(s.attendancePayFrom).slice(0, 10) : "");
    setDailyHours(Number(s.standardDailyHours ?? 8));
    setRestDays(Array.isArray(s.defaultRestDays) ? (s.defaultRestDays as string[]) : ["الجمعة"]);
  }, [open, s]);

  return (
    <Card>
      <CardContent className="p-3 flex items-center justify-between gap-3 flex-wrap text-sm">
        <div className="flex items-center gap-2">
          <Moon aria-hidden className="size-4 text-muted-foreground" />
          <span>الأجر بالحضور:</span>
          <span className={s?.attendancePayEnabled ? "font-medium text-[var(--status-active,#16a34a)]" : "text-muted-foreground"}>
            {q.isLoading ? "…" : s?.attendancePayEnabled ? `مفعَّل من ${String(s.attendancePayFrom ?? "").slice(0, 10)}` : "معطَّل"}
          </span>
          <span className="text-muted-foreground">·</span>
          <span>الوردية الليلية:</span>
          <span className={s?.nightShiftEnabled ? "font-medium" : "text-muted-foreground"}>
            {q.isLoading ? "…" : s?.nightShiftEnabled ? `حتى ${s.nightShiftCutoffHour}:00` : "معطَّلة"}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>تعديل</Button>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>إعدادات احتساب الحضور والأجر</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm max-h-[70vh] overflow-y-auto">
            <div className="rounded-md border p-3 space-y-2">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="size-4 mt-0.5" checked={payOn} onChange={(e) => setPayOn(e.target.checked)} />
                <span>
                  <span className="font-medium">الأجر بالحضور (للموظفين الشهريّين)</span>
                  <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    سعر ساعة الموظف = راتبه ÷ ساعات دوامه في الشهر، وأجرُه = ساعات حضوره الفعلية × ذلك السعر.
                    الغياب بلا أجر، والإجازة المدفوعة يوم دوامٍ كامل، وبلا راتب لا تُحتسب.
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
              <div className="space-y-1">
                <Label htmlFor="ap-hours">ساعات الدوام اليومية (افتراضي)</Label>
                <Input id="ap-hours" type="number" min={1} max={24} step="0.5" dir="ltr" value={dailyHours} disabled={!payOn} onChange={(e) => setDailyHours(Number(e.target.value))} />
              </div>
              <div className="space-y-1">
                <Label>أيام الراحة الأسبوعية (افتراضي)</Label>
                <div className="flex flex-wrap gap-2">
                  {WEEK_DAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                      <input
                        type="checkbox"
                        className="size-3.5"
                        disabled={!payOn}
                        checked={restDays.includes(d)}
                        onChange={(e) => setRestDays((prev) => (e.target.checked ? [...prev, d] : prev.filter((x) => x !== d)))}
                      />
                      {d}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  يوم الراحة لا يُطالَب بحضورٍ فيه ولا يُخصَم. يمكن تخصيصه لكل موظف من بطاقته.
                </p>
              </div>
            </div>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="size-4 mt-0.5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>
                <span className="font-medium">اعتبر بصمة الفجر إغلاقاً لوردية أمس</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  بدونها تُسجَّل وردية 22:00 ← 06:00 يومين ببصمة واحدة لكلٍّ، فتُحتسب صفر ساعات وصفر أجر لليلة عمل كاملة.
                </span>
              </span>
            </label>
            <div className="space-y-1">
              <Label htmlFor="ns-cutoff">ساعة الفصل (صباحاً)</Label>
              <Input id="ns-cutoff" type="number" min={1} max={12} dir="ltr" value={cutoff} disabled={!enabled} onChange={(e) => setCutoff(Number(e.target.value))} />
              <p className="text-xs text-muted-foreground">
                أيّ بصمة قبل هذه الساعة تُغلق وردية اليوم السابق إن كانت مفتوحة. بعدها تُعدّ بدايةَ يومٍ جديد.
              </p>
            </div>
            <p className="text-xs text-muted-foreground border-t pt-2">
              التغيير لا يُعيد حساب أيام مسجَّلة سابقاً — يسري على ما يصل بعده.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate({ nightShiftEnabled: enabled, nightShiftCutoffHour: cutoff, attendancePayEnabled: payOn, attendancePayFrom: payFrom || null, standardDailyHours: dailyHours, defaultRestDays: restDays })}>
              {save.isPending ? "جارٍ الحفظ…" : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
