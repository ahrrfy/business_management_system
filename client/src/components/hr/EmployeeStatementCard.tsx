/* ============================================================================
 * كشف حضور الموظف — بطاقة في صفحته (client/src/components/hr/EmployeeStatementCard.tsx)
 *
 * قرار المالك (٣١/٧): «أريد لكل يوم ساعاته من ساعة إلى ساعة وأجر الساعة لهذا اليوم»،
 * و«المجموع التراكميّ لأيام الشهر هو الراتب الذي يستحقّه».
 *
 * تعرض صفّاً لكل يوم دوام، وتسمح بتصحيح الأوقات مباشرةً للأيام الموسومة «يحتاج تصحيح»
 * (بصمةُ خروجٍ ناقصة أو ساعاتٌ تجاوزت سقف المعقولية) — والتصحيح اليدويّ لا يطمسه
 * الطيّ التلقائي لاحقاً. وتُطبَع A4 وتُصدَّر Excel وتُشارَك على واتساب.
 * ========================================================================== */
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
import { CalendarDays, FileSpreadsheet, PenLine, Printer, Send, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATE_LABEL: Record<string, string> = {
  present: "حضور",
  absent: "غياب",
  paidLeave: "إجازة مدفوعة",
  unpaidLeave: "إجازة بلا راتب",
  beforeStart: "قبل السريان",
  restWorked: "عمل يوم راحة",
};

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

export function EmployeeStatementCard({ employeeId, phone }: { employeeId: number; phone?: string | null }) {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [fix, setFix] = useState<{ date: string; checkIn: string; checkOut: string; hours: string } | null>(null);

  const q = trpc.attendance.employeeStatement.useQuery({ employeeId, period });
  const d = q.data;

  const correct = trpc.attendance.record.useMutation({
    onSuccess: async () => {
      notify.ok("صُحّحت أوقات اليوم — رُفع وسم المراجعة");
      setFix(null);
      await utils.attendance.employeeStatement.invalidate({ employeeId, period });
    },
    onError: (e) => notify.err(e),
  });

  /*
   * المستحقّ من الخادم بأساسه (`amountDue`/`dueBasis`) لا من حساب الحضور دائماً: المُعفى
   * بلا بصمات كان يرى — ويُشارك ويطبع — صفراً تحت سطرٍ يقول إن الحضور لا يؤثّر في راتبه.
   */
  const totalDue = useMemo(() => (d ? Number(d.amountDue) : 0), [d]);
  const dueLabel =
    d?.dueBasis === "exempt"
      ? "الراتب الثابت المستحقّ (لا يخضع للحضور)"
      : d?.dueBasis === "fixedSalary"
        ? "الراتب الثابت المستحقّ (الأجر بالحضور غير مفعَّل)"
        : d?.dueBasis === "hourly"
          ? "المستحقّ عن الشهر (أجرٌ بالساعة من سجلّ الحضور)"
          : "المستحقّ عن الشهر (أساس + أوفر تايم)";

  if (q.isLoading) return <Card><CardContent className="p-6 text-center text-muted-foreground">جارٍ تحميل الكشف…</CardContent></Card>;
  if (!d) return null;

  const shareText = [
    `كشف حضور — ${d.employee.name}`,
    `الشهر: ${d.period}`,
    d.dueBasis === "exempt" ? "راتب ثابت — لا يخضع للحضور" : null,
    `ساعات مستحقّة: ${d.totals.payableHours} من ${d.totals.scheduledHours}`,
    d.totals.absentDays > 0 ? `غياب: ${d.totals.absentDays} يوم` : null,
    Number(d.totals.overtimeHours) > 0 ? `أوفر تايم: ${d.totals.overtimeHours} ساعة` : null,
    `المستحقّ: ${iqd(String(totalDue))} د.ع`,
  ]
    .filter(Boolean)
    .join("\n");
  const wa = whatsappLink(phone);

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarDays aria-hidden className="size-4" />
          كشف الحضور والدوام
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="الشهر">
            {recentMonths().map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <Button variant="outline" size="sm" onClick={() => printAttendanceStatement(
            {
              employeeName: d.employee.name, employeeId: d.employee.id, position: d.employee.position,
              department: d.employee.department, branchName: d.employee.branchName,
              period: d.period, from: d.from, to: d.to, totals: d.totals,
              amountDue: d.amountDue, dueBasis: d.dueBasis,
            },
            d.days as never,
          )}>
            <Printer aria-hidden className="size-3.5" /> طباعة
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportRows(d.days as any[], {
            filename: `كشف حضور ${d.employee.name} ${d.period}`,
            title: `كشف حضور ودوام — ${d.employee.name}`,
            meta: [
              { label: "الشهر", value: d.period },
              { label: "الفترة", value: `${d.from} ← ${d.to}` },
              { label: "ساعات مقرَّرة", value: d.totals.scheduledHours },
              { label: "ساعات مستحقّة", value: d.totals.payableHours },
              // المستحقّ بأساسه — وإلّا قُرئ مجموعُ عمود «أجر اليوم» (صفرٌ للمُعفى) راتباً.
              { label: dueLabel, value: iqd(String(totalDue)) },
            ],
            columns: [
              { key: "date", header: "التاريخ" },
              { key: "dayName", header: "اليوم" },
              { key: "checkIn", header: "من", map: (r: any) => r.checkIn ?? "" },
              { key: "checkOut", header: "إلى", map: (r: any) => r.checkOut ?? "" },
              { key: "scheduledHours", header: "مقرَّر" },
              { key: "countedHours", header: "محتسَب" },
              { key: "overtimeHours", header: "إضافي" },
              { key: "rate", header: "سعر الساعة", money: true },
              { key: "amount", header: "أجر اليوم", money: true },
              { key: "state", header: "الحالة", map: (r: any) => STATE_LABEL[r.state] ?? r.state },
              { key: "needsReview", header: "يحتاج تصحيح", map: (r: any) => (r.needsReview ? "نعم" : "") },
            ],
            totalsRow: { amount: Number(d.totals.basePay), overtimeHours: Number(d.totals.overtimeHours) },
          })}>
            <FileSpreadsheet aria-hidden className="size-3.5" /> تصدير
          </Button>
          {wa && (
            <Button variant="outline" size="sm" asChild>
              <a href={`${wa}?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">
                <Send aria-hidden className="size-3.5" /> مشاركة
              </a>
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
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
        {d.totals.reviewDays > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
            <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
            <span>
              <span className="font-medium text-[var(--sem-warn)]">{d.totals.reviewDays} يوم يحتاج تصحيح</span> — بصمةُ
              خروجٍ ناقصة أو ساعاتٌ تجاوزت السقف المعقول. صحّح أوقاتها قبل اعتماد المسيّر.
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          {[
            { l: "ساعات مقرَّرة", v: d.totals.scheduledHours },
            { l: "ساعات مستحقّة", v: d.totals.payableHours },
            { l: "أوفر تايم", v: d.totals.overtimeHours },
            { l: "غياب (يوم)", v: String(d.totals.absentDays) },
          ].map((x) => (
            <div key={x.l} className="rounded-md border p-2">
              <div className="text-[11px] text-muted-foreground">{x.l}</div>
              <div className="tabular-nums font-medium" dir="ltr">{x.v}</div>
            </div>
          ))}
        </div>

        <ScrollTableShell bordered>
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">اليوم</th>
                <th className="p-2 text-center">من ← إلى</th>
                <th className="p-2 text-center">مقرَّر</th>
                <th className="p-2 text-center">محتسَب</th>
                <th className="p-2 text-center">إضافي</th>
                <th className="p-2 text-end">سعر الساعة</th>
                <th className="p-2 text-end">أجر اليوم</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {d.days.map((x: any) => (
                <tr key={x.date} className={`border-t ${x.needsReview ? "bg-[var(--sem-warn-bg)]/50" : ""}`}>
                  <td className="p-2 tabular-nums" dir="ltr">{x.date}</td>
                  <td className="p-2">{x.dayName}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{x.checkIn ? `${x.checkIn} ← ${x.checkOut ?? "—"}` : "—"}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{x.scheduledHours}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{x.countedHours}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{Number(x.overtimeHours) > 0 ? x.overtimeHours : "—"}</td>
                  <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(x.rate)}</td>
                  <td className="p-2 text-end tabular-nums font-medium" dir="ltr">{iqd(x.amount)}</td>
                  <td className="p-2 text-center">{STATE_LABEL[x.state] ?? x.state}</td>
                  <td className="p-2 text-center">
                    <button
                      className="text-primary hover:underline inline-flex items-center gap-1"
                      onClick={() => setFix({ date: x.date, checkIn: x.checkIn ?? "", checkOut: x.checkOut ?? "", hours: x.countedHours })}
                    >
                      <PenLine aria-hidden className="size-3" /> تصحيح
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-medium">
                <td className="p-2" colSpan={7}>{dueLabel}</td>
                <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(String(totalDue))}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </ScrollTableShell>
      </CardContent>

      {/* تصحيح أوقات يومٍ بعينه — الضرورات والظروف (قرار المالك) */}
      <Dialog open={!!fix} onOpenChange={(o) => !o && setFix(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>تصحيح أوقات {fix?.date}</DialogTitle></DialogHeader>
          {fix && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="fx-in">من</Label>
                  <Input id="fx-in" type="time" dir="ltr" value={fix.checkIn} onChange={(e) => setFix({ ...fix, checkIn: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fx-out">إلى</Label>
                  <Input id="fx-out" type="time" dir="ltr" value={fix.checkOut} onChange={(e) => setFix({ ...fix, checkOut: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-h">الساعات المحتسَبة</Label>
                <Input id="fx-h" type="number" min={0} max={24} step="0.25" dir="ltr" value={fix.hours} onChange={(e) => setFix({ ...fix, hours: e.target.value })} />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  التصحيح اليدويّ يُثبّت اليوم ويرفع وسم المراجعة، ولا يطمسه الجهاز لاحقاً —
                  الجهاز يتبع المدير لا العكس. يُسجَّل في سجلّ التدقيق باسمك.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFix(null)}>إلغاء</Button>
            <Button
              disabled={correct.isPending || !fix}
              onClick={() => fix && correct.mutate({
                employeeId,
                attendanceDate: fix.date,
                hours: Number(fix.hours) || 0,
                checkIn: fix.checkIn || undefined,
                checkOut: fix.checkOut || undefined,
                source: "manual",
              })}
            >
              {correct.isPending ? "جارٍ الحفظ…" : "حفظ التصحيح"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
