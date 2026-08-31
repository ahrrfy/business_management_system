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

export const IQD_DENOMINATIONS = [250, 500, 1000, 5000, 10000, 25000, 50000] as const;

export function isTodayUtc(date: string): boolean {
  return date === new Date().toISOString().slice(0, 10);
}
