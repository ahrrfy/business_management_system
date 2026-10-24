import {
  attendanceHoursViolation,
  computeSessionsSummary,
  spanHours,
} from "@shared/attendanceHours";
import { useMemo, useState } from "react";

type DayStatus = "PRESENT" | "LATE" | "ABSENT" | "LEAVE";
export type ShiftEditRow = {
  checkIn: string;
  checkOut: string;
  crossMidnight?: boolean;
};

export function useAttendanceCorrection() {
  const [fix, setFix] = useState<{
    date: string;
    shiftMode: "single" | "split";
    sessions: ShiftEditRow[];
    breakMinutes: string;
    checkIn: string;
    checkOut: string;
    hours: string;
    crossMidnight: boolean;
    status: DayStatus;
    lateDeductionMinutes: string;
    notes: string;
  } | null>(null);

  /*
   * تغيير أيّ من الوقتين أو مدّة الاستراحة/الزمنية يُعيد اشتقاق صافي الساعات فوراً.
   * الاشتقاق التلقائي يمنع السهو، والخادم يمنع الالتفاف.
   */
  const setFixTime = (patch: {
    checkIn?: string;
    checkOut?: string;
    crossMidnight?: boolean;
    breakMinutes?: string;
  }) =>
    setFix((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch };
      const inferredCross =
        patch.crossMidnight !== undefined
          ? patch.crossMidnight
          : Boolean(
              next.checkIn && next.checkOut && next.checkOut <= next.checkIn,
            );
      next.crossMidnight = inferredCross;
      if (next.status === "ABSENT" || next.status === "LEAVE") {
        return { ...next, hours: "0" };
      }
      const auto = spanHours(next.checkIn, next.checkOut, {
        crossMidnight: inferredCross,
      });
      if (auto == null) return next;
      const breakMins = Math.max(0, Number(next.breakMinutes) || 0);
      const netHours = Math.max(
        0,
        Math.round((auto - breakMins / 60) * 100) / 100,
      );
      return { ...next, hours: netHours.toFixed(2) };
    });

  const updateSplitSessions = (nextSessions: ShiftEditRow[]) =>
    setFix((cur) => {
      if (!cur) return cur;
      const summary = computeSessionsSummary(nextSessions);
      const nextCheckIn = summary.firstCheckIn ?? cur.checkIn;
      const nextCheckOut = summary.lastCheckOut ?? "";
      return {
        ...cur,
        sessions: nextSessions,
        checkIn: nextCheckIn,
        checkOut: nextCheckOut,
        crossMidnight: summary.lastCrossMidnight,
        breakMinutes:
          summary.breakMinutes > 0 ? String(summary.breakMinutes) : "",
        hours:
          cur.status === "ABSENT" || cur.status === "LEAVE"
            ? "0"
            : summary.totalHours > 0
              ? summary.totalHoursStr
              : cur.hours,
      };
    });

  const splitSummary = useMemo(
    () =>
      fix && fix.shiftMode === "split"
        ? computeSessionsSummary(fix.sessions)
        : null,
    [fix],
  );

  const fixSpan = fix
    ? spanHours(fix.checkIn, fix.checkOut, { crossMidnight: fix.crossMidnight })
    : null;
  const fixSingleNetSpan =
    fixSpan != null && fix
      ? Math.max(
          0,
          Math.round(
            (fixSpan - Math.max(0, Number(fix.breakMinutes) || 0) / 60) * 100,
          ) / 100,
        )
      : null;
  const isPaidFixStatus = fix
    ? fix.status === "PRESENT" || fix.status === "LATE"
    : true;
  /** مرآة حارس الخادم بالنواة نفسها — تمنع رحلةً بلا طائل وتشرح السبب مكان وقوعه. */
  const fixError = fix
    ? (isPaidFixStatus &&
        fix.shiftMode === "split" &&
        splitSummary?.violation) ||
      attendanceHoursViolation({
        checkIn: fix.checkIn,
        checkOut: fix.checkOut,
        hours: Number(fix.hours),
        isPaidStatus: isPaidFixStatus,
        crossMidnight: fix.crossMidnight,
        breakMinutes:
          fix.shiftMode === "single"
            ? Number(fix.breakMinutes) || 0
            : splitSummary?.breakMinutes,
        sessions: fix.shiftMode === "split" ? fix.sessions : undefined,
      })
    : null;

  return {
    fix,
    setFix,
    setFixTime,
    updateSplitSessions,
    splitSummary,
    fixSpan,
    fixSingleNetSpan,
    isPaidFixStatus,
    fixError,
  };
}
