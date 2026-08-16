import type { PeriodValue } from "@/components/reports/PeriodFilter";

/**
 * تقارير الدفتر لا تدّعي تغطيةً قبل لقطة بدء الدورة الحالية.
 * نعيد نطاقاً صالحاً مع إبقاء تاريخ النهاية، أو نرفعه إلى يوم البدء إن كان أقدم منه.
 */
export function clampDoubleEntryReportPeriod(
  period: PeriodValue,
  availableFrom: string | null | undefined,
): PeriodValue {
  if (!availableFrom || period.from >= availableFrom) return period;
  return {
    from: availableFrom,
    to: period.to < availableFrom ? availableFrom : period.to,
    preset: "custom",
  };
}
