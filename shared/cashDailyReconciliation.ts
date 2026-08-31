import Decimal from "decimal.js";

export const CASH_DAILY_STATUSES = [
  "MATCHED",
  "VARIANCE_OPEN",
  "RESOLVED_WITH_ADJUSTMENT",
  "CLOSED",
  "REOPENED",
] as const;

export type CashDailyStatus = (typeof CASH_DAILY_STATUSES)[number];

export const CASH_CUSTODY_COUNT_STATUSES = ["MATCHED", "VARIANCE_OPEN"] as const;
export type CashCustodyCountStatus = (typeof CASH_CUSTODY_COUNT_STATUSES)[number];

/** الفئات النقدية المقبولة في كل عدٍّ للدينار، بترتيب العرض من الأكبر للأصغر. */
export const IQD_DENOMINATIONS = [
  50_000,
  25_000,
  10_000,
  5_000,
  1_000,
  500,
  250,
] as const;

/** نصف أصغر وحدة مخزنة (0.01): ما دونه أو يساويه فرق تقريبي لا فرق نقدي. */
export const CASH_VARIANCE_EPSILON = "0.005" as const;

export function hasCashVariance(value: Decimal.Value): boolean {
  return new Decimal(value).abs().gt(CASH_VARIANCE_EPSILON);
}

export function isCashVarianceWithinTolerance(value: Decimal.Value): boolean {
  return !hasCashVariance(value);
}

export function isTodayUtc(date: string): boolean {
  return date === new Date().toISOString().slice(0, 10);
}
