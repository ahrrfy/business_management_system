import { AttendanceCorrectionMode } from "./AttendanceCorrectionMode";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDurationArabic } from "@shared/attendanceHours";
import type { EmployeeStatementModel } from "./useEmployeeStatement";
import { AttendanceTimeFields } from "./AttendanceTimeFields";

function nextDateStr(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function AttendanceCorrectionDialog({
  model,
}: {
  model: EmployeeStatementModel;
}) {
  const {
    can,
    fix,
    setFix,
    splitSummary,
    fixSpan,
    fixSingleNetSpan,
    isPaidFixStatus,
    fixError,
    correct,
    employeeId,
  } = model;
  return (
    <Dialog open={!!fix} onOpenChange={(o) => !o && setFix(null)}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>تصحيح دوام يوم {fix?.date}</DialogTitle>
        </DialogHeader>
        {fix && (
          <div className="space-y-3">
            <AttendanceCorrectionMode model={model} />
            <AttendanceTimeFields model={model} />

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
                      onClick={() =>
                        setFix({ ...fix, hours: fixSingleNetSpan.toFixed(2) })
                      }
                    >
                      حساب تلقائي من الوقتين والاستراحة (
                      {fixSingleNetSpan.toFixed(2)} س)
                    </button>
                  )}
                {fix.shiftMode === "split" &&
                  splitSummary &&
                  splitSummary.totalHours > 0 &&
                  isPaidFixStatus &&
                  Math.abs(Number(fix.hours) - splitSummary.totalHours) >
                    0.01 && (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() =>
                        setFix({ ...fix, hours: splitSummary.totalHoursStr })
                      }
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
                <p className="text-xs leading-relaxed text-[var(--sem-neg)]">
                  {fixError}
                </p>
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
                  <Label htmlFor="fx-late">
                    خصم تأخير إداري (دقائق — اختياري)
                  </Label>
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
                        status:
                          hadDeduction && !hasDeduction && fix.status === "LATE"
                            ? "PRESENT"
                            : fix.status,
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
                سيُخصم {Number(fix.lateDeductionMinutes)} دقيقة (
                {(Number(fix.lateDeductionMinutes) / 60).toFixed(2)} ساعة) من
                الساعات المسجَّلة ليصبح الصافي{" "}
                {Math.max(
                  0,
                  (Number(fix.hours) || 0) -
                    Number(fix.lateDeductionMinutes) / 60,
                ).toFixed(2)}{" "}
                ساعة.
              </p>
            )}
            <p className="text-xs text-muted-foreground leading-relaxed">
              التصحيح اليدويّ يُثبّت اليوم ويرفع وسم المراجعة، ولا يطمسه الجهاز
              أو إعادة المزامنة لاحقاً.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setFix(null)}>
            إلغاء
          </Button>
          <Button
            disabled={
              !can("attendance.record") ||
              correct.isPending ||
              !fix ||
              !!fixError
            }
            onClick={() => {
              if (!fix) return;
              const parsedLate = Number(fix.lateDeductionMinutes);
              const lateMin =
                isPaidFixStatus &&
                fix.lateDeductionMinutes.trim() !== "" &&
                Number.isFinite(parsedLate) &&
                parsedLate > 0
                  ? Math.round(parsedLate)
                  : undefined;
              const parsedBreak = Number(fix.breakMinutes);
              const breakMin =
                isPaidFixStatus &&
                Number.isFinite(parsedBreak) &&
                parsedBreak > 0
                  ? Math.round(parsedBreak)
                  : 0;
              correct.mutate(
                {
                  employeeId,
                  attendanceDate: fix.date,
                  hours: isPaidFixStatus ? Number(fix.hours) || 0 : 0,
                  status:
                    lateMin && lateMin > 0 && fix.status === "PRESENT"
                      ? "LATE"
                      : fix.status,
                  checkIn: fix.checkIn || undefined,
                  checkOut: fix.checkOut || undefined,
                  checkOutDate:
                    fix.crossMidnight && fix.checkOut
                      ? nextDateStr(fix.date)
                      : undefined,
                  lateDeductionMinutes: lateMin,
                  sessions:
                    isPaidFixStatus && fix.shiftMode === "split"
                      ? fix.sessions.filter((s) => s.checkIn || s.checkOut)
                      : undefined,
                  breakMinutes: breakMin,
                  notes: fix.notes.trim() || undefined,
                  source: "manual",
                },
                {
                  onSuccess: () =>
                    setFix((current) => (current === fix ? null : current)),
                },
              );
            }}
          >
            {correct.isPending ? "جارٍ الحفظ…" : "حفظ التصحيح"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
