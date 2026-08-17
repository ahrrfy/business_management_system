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
import { attendanceHoursViolation, spanHours } from "@shared/attendanceHours";
import { CalendarDays, FileSpreadsheet, Lock, PenLine, Printer, Send, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STATE_LABEL: Record<string, string> = {
  present: "حضور",
  absent: "غياب",
  open: "ينقص انصراف",
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

  /*
   * تغيير أيّ من الوقتين يُعيد اشتقاق الساعات فوراً. قبل ذلك كان حقل الساعات يُملأ مرّةً عند
   * الفتح ولا يتحرّك أبداً، فتُحفظ ساعاتٌ جامدة مع أوقاتٍ جديدة صحيحة — وأخطرها صفرٌ موروثٌ
   * من يومٍ حُسب غياباً: يُكمل المديرُ الانصرافَ الناقص فيُحفظ اليوم بأجر صفر ويُرفع عنه وسم
   * المراجعة، فلا يعود أحد ينتبه له. الاشتقاق التلقائي يمنع السهو، والخادم يمنع الالتفاف.
   */
  const setFixTime = (patch: { checkIn?: string; checkOut?: string }) =>
    setFix((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch };
      const auto = spanHours(next.checkIn, next.checkOut);
      return auto == null ? next : { ...next, hours: auto.toFixed(2) };
    });

  const fixSpan = fix ? spanHours(fix.checkIn, fix.checkOut) : null;
  /** مرآة حارس الخادم بالنواة نفسها — تمنع رحلةً بلا طائل وتشرح السبب مكان وقوعه. */
  const fixError = fix
    ? attendanceHoursViolation({ checkIn: fix.checkIn, checkOut: fix.checkOut, hours: Number(fix.hours), isPaidStatus: true })
    : null;

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
  /** لقطةُ الشهر المصروف — وجودُها يعني أن الرقم أعلاه مجمَّدٌ من المسيّر لا مشتقٌّ اليوم (ق٣). */
  const snap = d?.payrollSnapshot ?? null;
  const dueLabel = snap
    ? `المستحقّ عن الشهر (من مسيّر ${snap.status === "paid" ? "مدفوع" : "معتمد"})`
    : d?.dueBasis === "exempt"
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
              amountDue: d.amountDue, dueBasis: d.dueBasis, payrollSnapshot: snap,
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
              { key: "amount", header: "أجر أساس", money: true },
              { key: "overtimeAmount", header: "أجر إضافي", money: true },
              { key: "totalAmount", header: "إجمالي اليوم", money: true },
              { key: "state", header: "الحالة", map: (r: any) => STATE_LABEL[r.state] ?? r.state },
              { key: "needsReview", header: "يحتاج تصحيح", map: (r: any) => (r.needsReview ? "نعم" : "") },
            ],
            totalsRow: {
              amount: Number(d.totals.basePay),
              overtimeHours: Number(d.totals.overtimeHours),
              overtimeAmount: Number(d.totals.overtimePay),
              totalAmount: totalDue,
            },
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
                  الشهر {snap.status === "paid" ? "مدفوع" : "معتمد"} — الأرقام من المسيّر.
                </span>{" "}
                لا تتغيّر بتعديلٍ لاحق على الراتب أو الجدول أو إعدادات الحضور. الجدول أدناه تفصيلٌ للاطّلاع.
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5 text-[11px]">
              {[
                { l: "الأجر الإجمالي", v: snap.gross },
                { l: "أوفر تايم", v: snap.overtime },
                { l: "عمولة", v: snap.commission },
                { l: "استقطاع", v: snap.deductions },
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
              <span className="font-medium text-[var(--sem-neg)]">{d.totals.openDays} يوم بدخولٍ بلا انصراف</span> —
              ساعاتها مجهولةٌ لا صفر، ولذلك تُعرَض «ينقص انصراف» لا «غياب». صحّحها من زرّ «تصحيح»
              في صفّها؛ <span className="font-medium">توليد مسيّر هذا الشهر متوقّف حتى تُحسم</span> كي لا يُخصَم
              أجر يومٍ كامل بلا وجه.
            </span>
          </div>
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
                {/* عمودان لا عمودٌ واحد بسهم: الترويسة تُعرَض RTL والخلية كانت dir="ltr"،
                    فيقع الدخول تحت «إلى» ⇒ كل صفٍّ يُقرأ مقلوباً (تدقيق ١٧/٨). */}
                <th className="p-2 text-center">من</th>
                <th className="p-2 text-center">إلى</th>
                <th className="p-2 text-center">مقرَّر</th>
                <th className="p-2 text-center">محتسَب</th>
                <th className="p-2 text-center">إضافي</th>
                <th className="p-2 text-end">سعر الساعة</th>
                {/* «أجر اليوم» كان يعرض الأساس وحده فيبدو الإضافي ضائعاً — ثلاثة أعمدة تُظهر المسار كاملاً. */}
                <th className="p-2 text-end">أجر أساس</th>
                <th className="p-2 text-end">أجر إضافي</th>
                <th className="p-2 text-end">إجمالي اليوم</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {d.days.map((x: any) => (
                <tr key={x.date} className={`border-t ${x.needsReview ? "bg-[var(--sem-warn-bg)]/50" : ""}`}>
                  <td className="p-2 tabular-nums" dir="ltr">{x.date}</td>
                  <td className="p-2">{x.dayName}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{x.checkIn ?? "—"}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{x.checkOut ?? "—"}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{x.scheduledHours}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{x.countedHours}</td>
                  <td className="p-2 text-center tabular-nums" dir="ltr">{Number(x.overtimeHours) > 0 ? x.overtimeHours : "—"}</td>
                  <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(x.rate)}</td>
                  <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(x.amount)}</td>
                  <td className="p-2 text-end tabular-nums" dir="ltr">{Number(x.overtimeAmount) > 0 ? iqd(x.overtimeAmount) : "—"}</td>
                  <td className="p-2 text-end tabular-nums font-medium" dir="ltr">{iqd(x.totalAmount)}</td>
                  <td className="p-2 text-center">{STATE_LABEL[x.state] ?? x.state}</td>
                  <td className="p-2 text-center">
                    <button
                      className="text-primary hover:underline inline-flex items-center gap-1"
                      /*
                       * تُملأ بالساعات **الفعلية** لا المحتسَبة: المحتسَب مقصوصٌ عند المقرَّر
                       * (min(الفعلي، المقرَّر))، فتعبئتُه كانت تعني أن مجرّد فتح النافذة
                       * والحفظ يهبط بساعات اليوم إلى المقرَّر ⇒ **يُمحى الأوفر تايم صامتاً**.
                       */
                      onClick={() => setFix({ date: x.date, checkIn: x.checkIn ?? "", checkOut: x.checkOut ?? "", hours: x.attendedHours ?? x.countedHours })}
                    >
                      <PenLine aria-hidden className="size-3" /> تصحيح
                    </button>
                  </td>
                </tr>
              ))}
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

      {/* تصحيح أوقات يومٍ بعينه — الضرورات والظروف (قرار المالك) */}
      <Dialog open={!!fix} onOpenChange={(o) => !o && setFix(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>تصحيح أوقات {fix?.date}</DialogTitle></DialogHeader>
          {fix && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="fx-in">من</Label>
                  <Input id="fx-in" type="time" dir="ltr" value={fix.checkIn} onChange={(e) => setFixTime({ checkIn: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fx-out">إلى</Label>
                  <Input id="fx-out" type="time" dir="ltr" value={fix.checkOut} onChange={(e) => setFixTime({ checkOut: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-h">الساعات المحتسَبة</Label>
                <Input id="fx-h" type="number" min={0} max={24} step="0.25" dir="ltr" value={fix.hours} onChange={(e) => setFix({ ...fix, hours: e.target.value })} />
                {fixError ? (
                  <p className="text-xs leading-relaxed text-[var(--sem-neg)]">{fixError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {fixSpan != null
                      ? `تُحسب تلقائياً من الوقتين (${fixSpan.toFixed(2)} ساعة) وتتغيّر معهما — عدّلها يدوياً فقط لطرح استراحةٍ غير مبصومة.`
                      : "أكمِل وقتَي الدخول والانصراف لتُحسب الساعات تلقائياً."}
                  </p>
                )}
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
              disabled={correct.isPending || !fix || !!fixError}
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
