import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ListToolbar } from "@/components/list";
import { EmpAvatar, iqd } from "@/lib/hr/ui";
import { D } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Clock, Fingerprint, PenLine, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

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

const emptyForm = () => ({ employeeId: "", attendanceDate: today(), hours: "", checkIn: "", checkOut: "", source: "manual" as "manual" | "fingerprint" });

export default function Attendance() {
  const [, navigate] = useLocation();
  const [employeeId, setEmployeeId] = useState("");
  const [period, setPeriod] = useState(currentMonth());
  const [source, setSource] = useState("");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());

  const utils = trpc.useUtils();
  const opts = trpc.attendance.formOptions.useQuery();
  const input = useMemo(
    () => ({
      employeeId: employeeId ? Number(employeeId) : undefined,
      period: period || undefined,
      source: (source || undefined) as "fingerprint" | "manual" | undefined,
    }),
    [employeeId, period, source],
  );
  const list = trpc.attendance.list.useQuery(input);
  const rows = list.data ?? [];

  // المجاميع عبر decimal (لا جمع float على المبالغ — §5)؛ ثمّ تُعرَض عبر iqd()/toFixed.
  const totalHours = rows.reduce((s, r) => s.plus(D(r.hours ?? 0)), D(0));
  const totalAmount = rows.reduce((s, r) => s.plus(D(r.amount ?? 0)), D(0));
  const fingerprintCount = rows.filter((r) => r.source === "fingerprint").length;
  const manualCount = rows.filter((r) => r.source !== "fingerprint").length;

  const record = trpc.attendance.record.useMutation({
    onSuccess: async () => {
      notify.ok("تم تسجيل الحضور");
      setOpen(false);
      setForm(emptyForm());
      await Promise.all([utils.attendance.list.invalidate(), utils.attendance.monthSummary.invalidate()]);
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
      source: form.source,
    });
  }

  return (
    <div className="space-y-4">
      {/* الترويسة */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">الحضور والانصراف</h1>
          <p className="text-sm text-muted-foreground mt-1">نظام احتساب بالساعة — أجر اليوم = ساعات الحضور × سعر ساعة ذلك اليوم. المصدر: أجهزة البصمة.</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/hr/devices"><Fingerprint className="size-4" /> أجهزة البصمة</Link>
        </Button>
      </div>

      {/* مؤشرات */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label={`إجمالي ساعات ${monthLabel(period)}`} value={totalHours.toNumber().toLocaleString("en-US")} sub="للموظفين بالساعة" icon={<Clock className="size-5" />} />
        <StatCard label="المبلغ المستحق" value={iqd(totalAmount.toFixed(2))} sub="د.ع — قبل الاستقطاع" accent="var(--status-active, #16a34a)" icon={<Wallet className="size-5" />} />
        <StatCard label="سجلات بصمة" value={fingerprintCount.toLocaleString("en-US")} sub="مزامنة تلقائية" icon={<Fingerprint className="size-5" />} />
        <StatCard label="إدخالات يدوية" value={manualCount.toLocaleString("en-US")} sub="تحتاج توثيقاً" accent="var(--stock-low, #d97706)" icon={<PenLine className="size-5" />} />
      </div>

      {/* سجل الحضور */}
      <Card>
        <CardHeader>
          <ListToolbar
            title="سجل الحضور"
            count={rows.length}
            loading={list.isLoading}
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
              </>
            }
            exportSpec={{
              filename: `الحضور-${period}`,
              rows,
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-right">
                  <th className="p-2.5">الموظف</th>
                  <th className="p-2.5">اليوم</th>
                  <th className="p-2.5 text-center">التاريخ</th>
                  <th className="p-2.5 text-center">دخول</th>
                  <th className="p-2.5 text-center">خروج</th>
                  <th className="p-2.5 text-center">ساعات</th>
                  <th className="p-2.5 text-left">سعر الساعة</th>
                  <th className="p-2.5 text-left">أجر اليوم</th>
                  <th className="p-2.5 text-center">المصدر</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const weekend = r.dayName === "الجمعة" || r.dayName === "السبت";
                  return (
                    <tr key={r.id} className="border-t hover:bg-accent/40">
                      <td className="p-2.5">
                        <button onClick={() => navigate(`/hr/employees/${r.employeeId}`)} className="flex items-center gap-2 hover:text-primary">
                          <EmpAvatar name={r.employeeName} color={r.colorTag} photoUrl={r.photoUrl} sizePx={28} />
                          <span className="text-[13px] font-medium">{r.employeeName}</span>
                        </button>
                      </td>
                      <td className="p-2.5 text-[13px]">{r.dayName}</td>
                      <td className="p-2.5 text-center text-xs tabular-nums" dir="ltr">{r.attendanceDate}</td>
                      <td className="p-2.5 text-center tabular-nums" dir="ltr">{r.checkIn ? new Date(r.checkIn).toTimeString().slice(0, 5) : "—"}</td>
                      <td className="p-2.5 text-center tabular-nums" dir="ltr">{r.checkOut ? new Date(r.checkOut).toTimeString().slice(0, 5) : "—"}</td>
                      <td className="p-2.5 text-center tabular-nums">{Number(r.hours ?? 0)}</td>
                      <td className={`p-2.5 text-left tabular-nums ${weekend ? "text-amber-600 font-medium" : ""}`} dir="ltr">{iqd(r.hourlyRate)}</td>
                      <td className="p-2.5 text-left tabular-nums font-semibold" dir="ltr">{iqd(r.amount)}</td>
                      <td className="p-2.5 text-center">
                        {r.source === "fingerprint" ? (
                          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Fingerprint className="size-3.5" /> بصمة</span>
                        ) : (
                          <span className="text-[11px] text-amber-600 inline-flex items-center gap-1"><PenLine className="size-3.5" /> يدوي</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!list.isLoading && rows.length === 0 && (
                  <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">لا سجلات حضور في هذه الفترة. غيّر الفلاتر أو سجّل إدخالاً يدوياً.</td></tr>
                )}
                {rows.length > 0 && (
                  <tr className="border-t-2 border-border bg-muted/40 font-bold">
                    <td className="p-2.5" colSpan={5}>الإجمالي</td>
                    <td className="p-2.5 text-center tabular-nums">{totalHours.toNumber().toLocaleString("en-US")}</td>
                    <td></td>
                    <td className="p-2.5 text-left tabular-nums" dir="ltr">{iqd(totalAmount.toFixed(2))}</td>
                    <td></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
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
              <Label htmlFor="att-source">المصدر</Label>
              <select id="att-source" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as "manual" | "fingerprint" })}>
                <option value="manual">يدوي</option>
                <option value="fingerprint">بصمة</option>
              </select>
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
