import { toExcelMoney } from "@/lib/payrollAccrual";

/** مصدر مبلغ المخزون نفسه؛ لا تُستنتج شارة مستقلة من تاريخ اختاره المستخدم. */
export function inventoryValuationDescription(valuation: {
  source: "LIVE" | "SNAPSHOT";
  cutoffDate: string | null;
}): string {
  if (valuation.source === "SNAPSHOT") {
    return `لقطة رسمية${valuation.cutoffDate ? ` بتاريخ ${valuation.cutoffDate}` : ""}`;
  }
  return valuation.cutoffDate
    ? `تقديريّ من المخزون الحالي — لا لقطة رسمية لتاريخ ${valuation.cutoffDate}`
    : "المخزون الحالي (قراءة حيّة)";
}

type AttendanceMoney = {
  hourlyRate: string;
  basePay: string;
  overtimePay: string;
  totalDue: string;
};

/** التحويل الرقمي عند حد ملف Excel فقط؛ تبقى أموال الخدمة Decimal strings. */
export function monthlyAttendanceExportRows<T extends AttendanceMoney>(
  rows: readonly T[],
) {
  return rows.map((row) => ({
    ...row,
    hourlyRate: toExcelMoney(row.hourlyRate),
    basePay: toExcelMoney(row.basePay),
    overtimePay: toExcelMoney(row.overtimePay),
    totalDue: toExcelMoney(row.totalDue),
  }));
}
