/* ============================================================================
 * تقرير الحضور الشهريّ لكل الموظفين (client/src/pages/MonthlyAttendanceReport.tsx)
 *
 * صفٌّ لكل موظف بالمجاميع — الصورة الشاملة قبل توليد المسيّر. يُبنى بنواة المسيّر
 * نفسها فلا ينحرف عن الكشف الفرديّ ولا عن ما يُدفع فعلاً.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState, TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { exportRows } from "@/lib/export";
import { iqd } from "@/lib/hr/ui";
import { printMonthlyAttendance } from "@/lib/printing/printMonthlyAttendance";
import { trpc } from "@/lib/trpc";
import { CalendarDays, FileSpreadsheet, Printer, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const MONTH_NAMES = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"];
function monthLabel(p: string): string {
  const [y, m] = p.split("-").map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
}
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

/** رقم بمنزلتين وفواصل — تنسيقٌ موحّد لكل أعمدة الساعات. */
const h2 = (v: string | number) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function MonthlyAttendanceReport() {
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const q = trpc.attendance.monthlyReport.useQuery({ period });
  const d = q.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="تقرير الحضور الشهريّ"
        description="صفٌّ لكل موظف — الساعات المقرَّرة والمستحقّة والغياب والإضافيّ والمستحقّ. يُحسب بنواة مسيّر الرواتب نفسها."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/attendance"><CalendarDays className="size-4" /> سجلّ الحضور</Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="p-3 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="الشهر">
              {recentMonths().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
            {d && (
              <span className="text-xs text-muted-foreground">
                {d.totals.employees} موظفاً{d.totals.exempt > 0 ? ` · ${d.totals.exempt} معفى من الحضور` : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              disabled={!d || d.rows.length === 0}
              onClick={() => d && printMonthlyAttendance({ period: d.period, rows: d.rows as never, totals: d.totals })}
            >
              <Printer aria-hidden className="size-3.5" /> طباعة
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!d || d.rows.length === 0}
              onClick={() => d && exportRows(d.rows as any[], {
                filename: `تقرير الحضور الشهريّ ${d.period}`,
                title: `تقرير الحضور الشهريّ — ${monthLabel(d.period)}`,
                meta: [
                  { label: "الموظفون", value: String(d.totals.employees) },
                  { label: "ساعات مستحقّة", value: d.totals.payableHours },
                  { label: "أوفر تايم", value: d.totals.overtimeHours },
                  { label: "أيام غياب", value: String(d.totals.absentDays) },
                ],
                columns: [
                  { key: "employeeName", header: "الموظف" },
                  { key: "position", header: "الوظيفة", map: (r: any) => r.position ?? "" },
                  { key: "department", header: "القسم", map: (r: any) => r.department ?? "" },
                  { key: "branchName", header: "الفرع", map: (r: any) => r.branchName ?? "" },
                  { key: "scheduledHours", header: "ساعات مقرَّرة" },
                  { key: "payableHours", header: "ساعات مستحقّة" },
                  { key: "unpaidHours", header: "ساعات غير مستحقّة" },
                  { key: "absentDays", header: "أيام غياب" },
                  { key: "unpaidLeaveDays", header: "إجازة بلا راتب" },
                  { key: "overtimeHours", header: "أوفر تايم (ساعة)" },
                  { key: "restWorkedHours", header: "عمل يوم راحة (ساعة)" },
                  { key: "hourlyRate", header: "سعر الساعة", money: true },
                  { key: "basePay", header: "الأجر الأساس", money: true },
                  { key: "overtimePay", header: "أجر الإضافيّ", money: true },
                  { key: "totalDue", header: "المستحقّ", money: true },
                  { key: "reviewDays", header: "أيام يحتاج تصحيح" },
                ],
                totalsRow: { totalDue: Number(d.totals.totalDue), overtimeHours: Number(d.totals.overtimeHours), absentDays: d.totals.absentDays },
              })}
            >
              <FileSpreadsheet aria-hidden className="size-3.5" /> تصدير Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      {d && d.totals.withoutSchedule > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
          <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
          <span>
            <span className="font-medium text-[var(--sem-warn)]">{d.totals.withoutSchedule} موظفاً بلا جدول دوامٍ خاصّ</span> —
            يُحسبون على الجدول الاحتياطيّ. افتح بطاقة كلٍّ منهم واضبط ساعات أيامه وأسعارها.
          </span>
        </div>
      )}
      {d && d.totals.reviewDays > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs">
          <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-[var(--sem-warn)]" />
          <span>
            <span className="font-medium text-[var(--sem-warn)]">{d.totals.reviewDays} يوماً يحتاج تصحيح</span> عبر الموظفين —
            صحّحها من كشف كل موظف قبل اعتماد المسيّر.
          </span>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-start">الموظف</th>
                  <th className="p-2 text-start">القسم</th>
                  <th className="p-2 text-center">مقرَّر</th>
                  <th className="p-2 text-center">مستحقّ</th>
                  <th className="p-2 text-center">غياب</th>
                  <th className="p-2 text-center">إضافيّ</th>
                  <th className="p-2 text-center">يوم راحة</th>
                  <th className="p-2 text-end">سعر الساعة</th>
                  <th className="p-2 text-end">المستحقّ</th>
                  <th className="p-2 text-center">تصحيح</th>
                </tr>
              </thead>
              <tbody>
                {(d?.rows ?? []).map((r) => (
                  <tr key={r.employeeId} className="border-t hover:bg-accent/40">
                    <td className="p-2">
                      <Link href={`/hr/employees/${r.employeeId}`} className="font-medium hover:underline">{r.employeeName}</Link>
                      {r.position && <div className="text-[11px] text-muted-foreground">{r.position}</div>}
                    </td>
                    <td className="p-2 text-muted-foreground">{r.department ?? "—"}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{h2(r.scheduledHours)}</td>
                    <td className="p-2 text-center tabular-nums font-medium" dir="ltr">{h2(r.payableHours)}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{r.absentDays || "—"}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{Number(r.overtimeHours) > 0 ? h2(r.overtimeHours) : "—"}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{Number(r.restWorkedHours) > 0 ? h2(r.restWorkedHours) : "—"}</td>
                    <td className="p-2 text-end tabular-nums" dir="ltr">{iqd(r.hourlyRate)}</td>
                    <td className="p-2 text-end tabular-nums font-bold" dir="ltr">
                      {iqd(r.totalDue)}
                      {r.dueBasis !== "attendance" && (
                        <div className="text-[10px] font-normal text-muted-foreground">
                          {r.dueBasis === "exempt" ? "راتب ثابت (معفى)" : r.dueBasis === "hourly" ? "بالساعة" : "راتب ثابت"}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-center tabular-nums">
                      {r.reviewDays > 0 ? <span className="text-[var(--sem-warn)] font-medium">{r.reviewDays}</span> : "—"}
                    </td>
                  </tr>
                ))}
                {q.isLoading && <tr><td colSpan={10} className="p-0"><LoadingState /></td></tr>}
                {q.isError && <tr><td colSpan={10} className="p-0"><ErrorState message="تعذّر تحميل التقرير." onRetry={() => q.refetch()} /></td></tr>}
                {!q.isLoading && !q.isError && (d?.rows.length ?? 0) === 0 && (
                  <TableEmptyRow colSpan={10} message="لا موظفين في هذا الشهر." />
                )}
              </tbody>
              {d && d.rows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 font-medium bg-muted/30">
                    <td className="p-2" colSpan={3}>المجموع ({d.totals.employees} موظفاً)</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{h2(d.totals.payableHours)}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{d.totals.absentDays || "—"}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{h2(d.totals.overtimeHours)}</td>
                    <td className="p-2 text-center tabular-nums" dir="ltr">{h2(d.totals.restWorkedHours)}</td>
                    <td />
                    <td className="p-2 text-end tabular-nums font-bold" dir="ltr">{iqd(d.totals.totalDue)}</td>
                    <td className="p-2 text-center tabular-nums">{d.totals.reviewDays || "—"}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>
    </div>
  );
}
