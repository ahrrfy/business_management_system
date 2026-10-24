import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { iqd } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { whatsappLink } from "@/lib/intlPhone";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAttendanceCorrection } from "./useAttendanceCorrection";

export function useEmployeeStatement({
  employeeId,
  phone,
}: {
  employeeId: number;
  phone?: string | null;
}) {
  const { can } = useCatalogPeopleOperationAccess();
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const correction = useAttendanceCorrection();
  const {
    fix,
    setFix,
    setFixTime,
    updateSplitSessions,
    splitSummary,
    fixSpan,
    fixSingleNetSpan,
    isPaidFixStatus,
    fixError,
  } = correction;
  const q = trpc.attendance.employeeStatement.useQuery(
    { employeeId, period },
    { enabled: can("attendance.employeeStatement") },
  );
  const d = q.data;

  const correct = trpc.attendance.record.useMutation({
    onSuccess: async (_result, input) => {
      notify.ok("حُفظ التصحيح اليدوي لليوم — رُفع وسم المراجعة");
      await Promise.all([
        utils.attendance.employeeStatement.invalidate({
          employeeId: input.employeeId,
          period: input.attendanceDate.slice(0, 7),
        }),
        utils.attendance.list.invalidate(),
        utils.attendance.summary.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e),
  });

  const autoHealedKeyRef = useRef<string | null>(null);
  const manualRecomputeRef = useRef(false);
  const recompute = trpc.attendance.recomputeRates.useMutation({
    onSuccess: async (res) => {
      const totalChanged =
        (res.updated ?? 0) +
        (res.refoldedDays ?? 0) +
        (res.cleanedGhostDays ?? 0);
      if (manualRecomputeRef.current || totalChanged > 0) {
        notify.ok(
          totalChanged > 0
            ? `تمّت مزامنة البصمات وإعادة احتساب الشهر (${totalChanged} يوم محدَّث)`
            : "تمّ التحقّق والمزامنة — جميع الساعات والأجور محدَّثة ومطابقة",
        );
      }
      manualRecomputeRef.current = false;
      await Promise.all([
        utils.attendance.employeeStatement.invalidate({ employeeId, period }),
        utils.attendance.list.invalidate(),
        utils.attendance.summary.invalidate(),
      ]);
    },
    onError: (e) => {
      if (manualRecomputeRef.current) notify.err(e);
      manualRecomputeRef.current = false;
    },
  });

  useEffect(() => {
    const key = `${employeeId}:${period}`;
    if (
      d?.needsHealing &&
      !d?.payrollSnapshot &&
      can("attendance.recomputeRates") &&
      autoHealedKeyRef.current !== key
    ) {
      autoHealedKeyRef.current = key;
      manualRecomputeRef.current = false;
      recompute.mutate({ period, employeeId });
    }
  }, [d?.needsHealing, d?.payrollSnapshot, employeeId, period, can]);

  /*
   * المستحقّ من الخادم بأساسه (`amountDue`/`dueBasis`) لا من حساب الحضور دائماً: المُعفى
   * بلا بصمات كان يرى — ويُشارك ويطبع — صفراً تحت سطرٍ يقول إن الحضور لا يؤثّر في راتبه.
   */
  const totalDue = useMemo(() => (d ? Number(d.amountDue) : 0), [d]);
  /** لقطةُ الشهر المصروف — وجودُها يعني أن الرقم أعلاه مجمَّدٌ من المسيّر لا مشتقٌّ اليوم (ق٣). */
  const snap = d?.payrollSnapshot ?? null;
  const dueLabel = snap
    ? `الأجر المستحقّ عن الشهر (من مسيّر ${snap.status === "paid" ? "مدفوع" : "معتمد"})`
    : d?.dueBasis === "exempt"
      ? "الراتب الثابت المستحقّ (لا يخضع للحضور)"
      : d?.dueBasis === "fixedSalary"
        ? "الراتب الثابت المستحقّ (الأجر بالحضور غير مفعَّل)"
        : d?.dueBasis === "hourly"
          ? "الأجر المستحقّ عن الشهر (أجرٌ بالساعة من سجلّ الحضور)"
          : "صافي الأجر المستحقّ عن الشهر (أجر الدوام + الإضافي)";

  const shareText = d
    ? [
        `كشف حضور ودوام — ${d.employee.name}`,
        `الشهر: ${d.period}`,
        d.dueBasis === "exempt" ? "راتب ثابت — لا يخضع للحضور" : null,
        `الساعات المدفوعة: ${d.totals.payableHours} من أصل ${d.totals.scheduledHours} ساعة مطلوبة`,
        d.totals.absentDays > 0
          ? `أيام الغياب: ${d.totals.absentDays} يوم`
          : null,
        Number(d.totals.overtimeHours) > 0
          ? `الساعات الإضافية (أوفر تايم): ${d.totals.overtimeHours} ساعة`
          : null,
        `الأجر المستحقّ: ${iqd(String(totalDue))} د.ع`,
        // شهرٌ مصروف: الرسالة تذهب للموظف على واتساب، فيلزمها الصافي الذي قبضه لا الإجماليّ وحده.
        snap
          ? `الصافي المصروف: ${iqd(snap.net)} د.ع (من مسيّر ${snap.status === "paid" ? "مدفوع" : "معتمد"})`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const wa = whatsappLink(phone);

  return {
    can,
    utils,
    period,
    setPeriod,
    fix,
    setFix,
    setFixTime,
    updateSplitSessions,
    splitSummary,
    fixSpan,
    fixSingleNetSpan,
    isPaidFixStatus,
    fixError,
    q,
    d,
    correct,
    recompute,
    totalDue,
    snap,
    dueLabel,
    shareText,
    wa,
    employeeId,
    manualRecomputeRef,
  };
}
export type EmployeeStatementModel = ReturnType<typeof useEmployeeStatement>;
