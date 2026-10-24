import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { iqd } from "@/lib/hr/ui";
import {
  buildDefaultSplitSessions,
  formatDurationArabic,
  parseAttendanceDayDetails,
  parseManualAttendanceEdit,
} from "@shared/attendanceHours";
import { Clock, Coffee, PenLine } from "lucide-react";
import type { EmployeeStatementModel } from "./useEmployeeStatement";
import { ATTENDANCE_STATE_LABELS as STATE_LABEL } from "@shared/hr";
import type { ShiftEditRow } from "./useAttendanceCorrection";

export function AttendanceStatementTable({
  model,
}: {
  model: EmployeeStatementModel;
}) {
  const { setFix, totalDue, snap, dueLabel } = model;
  const d = model.d!;
  return (
    <ScrollTableShell bordered>
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="p-2 text-start">التاريخ</th>
            <th className="p-2 text-start">اليوم</th>
            <th className="p-2 text-center" title="وقت أوّل بصمة دخول في اليوم">
              الدخول
            </th>
            <th
              className="p-2 text-center"
              title="وقت آخر بصمة انصراف في اليوم"
            >
              الانصراف
            </th>
            <th
              className="p-2 text-center"
              title="ساعات العمل المطلوبة لهذا اليوم في جدول الموظف"
            >
              المطلوب
            </th>
            <th
              className="p-2 text-center"
              title="صافي ساعات العمل المحسوبة ضمن الدوام الأساس (بعد طرح الاستراحات/الزمنيات)"
            >
              صافي العمل
            </th>
            <th
              className="p-2 text-center"
              title="الساعات الإضافية التي عملها الموظف فوق ساعات اليوم المطلوبة"
            >
              إضافي
            </th>
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
              <tr
                key={x.date}
                className={`border-t ${x.needsReview ? "bg-[var(--sem-warn-bg)]/50" : ""}`}
              >
                <td className="p-2 tabular-nums" dir="ltr">
                  {x.date}
                </td>
                <td className="p-2">{x.dayName}</td>
                <td className="p-2 text-center tabular-nums" dir="ltr">
                  {x.checkIn ?? "—"}
                </td>
                <td className="p-2 text-center tabular-nums" dir="ltr">
                  {x.checkOut ? (
                    <>
                      {x.checkOut}
                      {x.checkOutNextDay ? (
                        <span
                          className="ms-1 text-[10px] text-muted-foreground"
                          title="انصراف بعد منتصف الليل (اليوم التالي)"
                        >
                          (+1)
                        </span>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="p-2 text-center tabular-nums" dir="ltr">
                  {x.scheduledHours}
                </td>
                <td
                  className="p-2 text-center tabular-nums font-medium"
                  dir="ltr"
                >
                  {x.countedHours}
                </td>
                <td className="p-2 text-center tabular-nums" dir="ltr">
                  {Number(x.overtimeHours) > 0 ? x.overtimeHours : "—"}
                </td>
                <td className="p-2 text-end tabular-nums" dir="ltr">
                  {iqd(x.rate)}
                </td>
                <td className="p-2 text-end tabular-nums" dir="ltr">
                  {iqd(x.amount)}
                </td>
                <td className="p-2 text-end tabular-nums" dir="ltr">
                  {Number(x.overtimeAmount) > 0 ? iqd(x.overtimeAmount) : "—"}
                </td>
                <td className="p-2 text-end tabular-nums font-medium" dir="ltr">
                  {iqd(x.totalAmount)}
                </td>
                <td className="p-2 text-start">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-medium">
                      {STATE_LABEL[x.state] ?? x.state}
                    </span>
                    {x.source === "manual" ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        تعديل يدوي
                      </span>
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
                      <Clock
                        aria-hidden
                        className="size-2.5 shrink-0 text-primary"
                      />
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
                          {s.checkIn}→{s.checkOut ?? "بلا انصراف"}
                          {s.crossMidnight ? "(+1)" : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {x.cleanNotes && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {x.cleanNotes}
                    </div>
                  )}
                  {x.needsReview &&
                    x.reviewReason &&
                    x.reviewReason !== "manual_late_override" && (
                      <div className="mt-0.5 text-[10px] text-[var(--sem-warn)] font-medium">
                        {x.reviewReason}
                      </div>
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
                          x.checkOutNextDay ||
                          (x.checkIn && x.checkOut && x.checkOut <= x.checkIn),
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
                          : buildDefaultSplitSessions(x.checkIn, x.checkOut, {
                              crossMidnight,
                            });
                        setFix({
                          date: x.date,
                          shiftMode: isSplit ? "split" : "single",
                          sessions: initSessions,
                          breakMinutes:
                            details.breakMinutes > 0
                              ? String(details.breakMinutes)
                              : "",
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
            <td className="p-2" colSpan={8}>
              {dueLabel}
            </td>
            <td className="p-2 text-end tabular-nums" dir="ltr">
              {iqd(d.totals.basePay)}
            </td>
            <td className="p-2 text-end tabular-nums" dir="ltr">
              {iqd(d.totals.overtimePay)}
            </td>
            <td className="p-2 text-end tabular-nums" dir="ltr">
              {iqd(String(totalDue))}
            </td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </ScrollTableShell>
  );
}
