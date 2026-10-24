import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  formatDurationArabic,
  spanHours,
  suggestNextSplitSession,
} from "@shared/attendanceHours";
import { Coffee, Plus, Trash2 } from "lucide-react";
import type { EmployeeStatementModel } from "./useEmployeeStatement";
const BREAK_PRESETS = [
  { label: "بلا استراحة", mins: "" },
  { label: "30 د", mins: "30" },
  { label: "60 د (ساعة)", mins: "60" },
  { label: "90 د (ساعة ونصف)", mins: "90" },
  { label: "120 د (ساعتان)", mins: "120" },
  { label: "180 د (3 س)", mins: "180" },
];

export function AttendanceTimeFields({
  model,
}: {
  model: EmployeeStatementModel;
}) {
  const {
    fix,
    setFixTime,
    updateSplitSessions,
    splitSummary,
    isPaidFixStatus,
  } = model;
  const d = model.d!;
  if (!fix) return null;
  return (
    <>
      {fix.shiftMode === "single" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="fx-in">وقت الدخول</Label>
              <Input
                id="fx-in"
                type="time"
                dir="ltr"
                value={fix.checkIn}
                onChange={(e) => setFixTime({ checkIn: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fx-out">وقت الانصراف</Label>
              <Input
                id="fx-out"
                type="time"
                dir="ltr"
                value={fix.checkOut}
                onChange={(e) => setFixTime({ checkOut: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="size-3.5"
              checked={fix.crossMidnight}
              onChange={(e) => setFixTime({ crossMidnight: e.target.checked })}
            />
            <span>انصراف بعد منتصف الليل (اليوم التالي +1)</span>
          </label>

          {isPaidFixStatus && (
            <div className="rounded-md border bg-muted/20 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label
                  htmlFor="fx-break"
                  className="text-xs flex items-center gap-1.5"
                >
                  <Coffee aria-hidden className="size-3.5 text-amber-600" />
                  استراحة / زمنية أثناء الدوام (دقائق — تُطرح من المدى)
                </Label>
                {Number(fix.breakMinutes) > 0 && (
                  <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    {formatDurationArabic(Number(fix.breakMinutes))}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="fx-break"
                  type="number"
                  min={0}
                  max={720}
                  step="15"
                  dir="ltr"
                  placeholder="0"
                  className="h-8 text-xs w-28"
                  value={fix.breakMinutes}
                  onChange={(e) => setFixTime({ breakMinutes: e.target.value })}
                />
                <div className="flex flex-wrap gap-1">
                  {BREAK_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setFixTime({ breakMinutes: p.mins })}
                      className={`rounded border px-2 py-1 text-[10px] transition-colors ${
                        fix.breakMinutes === p.mins
                          ? "border-primary bg-primary/10 font-medium text-primary"
                          : "bg-background hover:bg-muted"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-md border bg-muted/20 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">
              فترات العمل الفعلي في هذا اليوم
            </span>
            {fix.sessions.length < 4 && (
              <button
                type="button"
                onClick={() =>
                  updateSplitSessions([
                    ...fix.sessions,
                    suggestNextSplitSession(fix.sessions),
                  ])
                }
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus aria-hidden className="size-3" /> إضافة فترة ثالثة
              </button>
            )}
          </div>
          {fix.sessions.map((s, idx) => {
            const sSpan = spanHours(s.checkIn, s.checkOut, {
              crossMidnight: Boolean(s.crossMidnight),
            });
            return (
              <div
                key={idx}
                className="rounded border bg-background p-2 space-y-1.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">
                    {idx === 0
                      ? "الفترة الأولى (قبل الاستراحة/الزمنية)"
                      : idx === 1
                        ? "الفترة الثانية (بعد العودة)"
                        : `الفترة رقم ${idx + 1}`}
                  </span>
                  <div className="flex items-center gap-2">
                    {sSpan != null && (
                      <span
                        className="text-[11px] text-primary font-medium"
                        dir="ltr"
                      >
                        {sSpan.toFixed(2)} س
                      </span>
                    )}
                    {fix.sessions.length > 2 && (
                      <button
                        type="button"
                        onClick={() =>
                          updateSplitSessions(
                            fix.sessions.filter((_, i) => i !== idx),
                          )
                        }
                        className="text-destructive hover:opacity-80"
                        title="حذف الفترة"
                      >
                        <Trash2 aria-hidden className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-muted-foreground">
                      وقت الدخول
                    </Label>
                    <Input
                      type="time"
                      dir="ltr"
                      className="h-8 text-xs"
                      value={s.checkIn}
                      onChange={(e) => {
                        const next = fix.sessions.map((row, i) =>
                          i === idx ? { ...row, checkIn: e.target.value } : row,
                        );
                        updateSplitSessions(next);
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground">
                      وقت الانصراف
                    </Label>
                    <Input
                      type="time"
                      dir="ltr"
                      className="h-8 text-xs"
                      value={s.checkOut}
                      onChange={(e) => {
                        const val = e.target.value;
                        const next = fix.sessions.map((row, i) =>
                          i === idx
                            ? {
                                ...row,
                                checkOut: val,
                                crossMidnight: Boolean(
                                  row.checkIn && val && val <= row.checkIn,
                                ),
                              }
                            : row,
                        );
                        updateSplitSessions(next);
                      }}
                    />
                  </div>
                </div>
                {idx === fix.sessions.length - 1 && (
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground pt-0.5">
                    <input
                      type="checkbox"
                      className="size-3"
                      checked={Boolean(s.crossMidnight)}
                      onChange={(e) => {
                        const next = fix.sessions.map((row, i) =>
                          i === idx
                            ? { ...row, crossMidnight: e.target.checked }
                            : row,
                        );
                        updateSplitSessions(next);
                      }}
                    />
                    <span>انصراف هذه الفترة بعد منتصف الليل (+1)</span>
                  </label>
                )}
              </div>
            );
          })}

          {splitSummary && splitSummary.breaks.length > 0 && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5">
                <Coffee aria-hidden className="size-3.5" />
                استراحة / زمنية بين الفترات (
                {splitSummary.breaks
                  .map((b) => `${b.from}←${b.to}`)
                  .join(" ، ")}
                ):
              </span>
              <span className="font-semibold">
                {formatDurationArabic(splitSummary.breakMinutes)} (تُطرح
                تلقائياً)
              </span>
            </div>
          )}
          {splitSummary && splitSummary.hasOpenSession && (
            <div className="text-xs text-[var(--sem-warn)]">
              الفترة التي بدأت عند {splitSummary.openSessionCheckIn} لا يزال
              ينقصها وقت الانصراف — أدخل وقت انصرافها لإكمال احتسابها.
            </div>
          )}
        </div>
      )}
    </>
  );
}
