import { AppSelect } from "@/components/ui/AppSelect";
import { Label } from "@/components/ui/label";
import {
  buildDefaultSplitSessions,
  computeSessionsSummary,
  spanHours,
} from "@shared/attendanceHours";
import type { EmployeeStatementModel } from "./useEmployeeStatement";
import type { ShiftEditRow } from "./useAttendanceCorrection";
type DayStatus = "PRESENT" | "LATE" | "ABSENT" | "LEAVE";
export function AttendanceCorrectionMode({
  model,
}: {
  model: EmployeeStatementModel;
}) {
  const { fix, setFix, isPaidFixStatus } = model;
  if (!fix) return null;
  return (
    <>
      <div className="space-y-1">
        <Label>حالة اليوم</Label>
        <AppSelect
          className="h-9 border-input px-2 text-sm"
          value={fix.status}
          onValueChange={(v) => {
            const nextStatus = v as DayStatus;
            if (nextStatus === "ABSENT" || nextStatus === "LEAVE") {
              setFix({
                ...fix,
                status: nextStatus,
                hours: "0",
                lateDeductionMinutes: "",
                breakMinutes: "",
              });
            } else if (fix.shiftMode === "split") {
              const summary = computeSessionsSummary(fix.sessions);
              setFix({
                ...fix,
                status: nextStatus,
                hours: summary.totalHours > 0 ? summary.totalHoursStr : "8",
              });
            } else {
              const auto = spanHours(fix.checkIn, fix.checkOut, {
                crossMidnight: fix.crossMidnight,
              });
              const breakMins = Math.max(0, Number(fix.breakMinutes) || 0);
              const net =
                auto != null
                  ? Math.max(0, Math.round((auto - breakMins / 60) * 100) / 100)
                  : null;
              setFix({
                ...fix,
                status: nextStatus,
                hours:
                  net != null
                    ? net.toFixed(2)
                    : !(Number(fix.hours) > 0)
                      ? "8"
                      : fix.hours,
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
                const auto = spanHours(fix.checkIn, fix.checkOut, {
                  crossMidnight: fix.crossMidnight,
                });
                const rawBreakMins = Math.max(0, Number(fix.breakMinutes) || 0);
                const breakMins =
                  auto != null && rawBreakMins / 60 >= auto ? 0 : rawBreakMins;
                const net =
                  auto != null
                    ? Math.max(
                        0,
                        Math.round((auto - breakMins / 60) * 100) / 100,
                      )
                    : null;
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
              <div className="text-[10px] text-muted-foreground">
                دخول وانصراف مع خيار طرح استراحة/زمنية
              </div>
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
                    : buildDefaultSplitSessions(fix.checkIn, fix.checkOut, {
                        crossMidnight: fix.crossMidnight,
                      });
                const summary = computeSessionsSummary(initialSessions);
                setFix({
                  ...fix,
                  shiftMode: "split",
                  sessions: initialSessions,
                  checkIn: summary.firstCheckIn ?? fix.checkIn,
                  checkOut: summary.lastCheckOut ?? fix.checkOut,
                  crossMidnight: summary.lastCrossMidnight,
                  breakMinutes:
                    summary.breakMinutes > 0
                      ? String(summary.breakMinutes)
                      : "",
                  hours:
                    summary.totalHours > 0 ? summary.totalHoursStr : fix.hours,
                });
              }}
              className={`rounded-md border px-3 py-2 text-xs text-start transition-colors ${
                fix.shiftMode === "split"
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-input hover:bg-muted/50"
              }`}
            >
              <div className="font-semibold">
                دوام مجزّأ / فترتان (خروج وعودة)
              </div>
              <div className="text-[10px] text-muted-foreground">
                خروج للاستراحة أو زمنية ثم عودة لإكمال الدوام
              </div>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
