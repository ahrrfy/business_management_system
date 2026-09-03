export const MISSED_DAILY_COUNT_EXCEPTION_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;

export type MissedDailyCountExceptionStatus =
  (typeof MISSED_DAILY_COUNT_EXCEPTION_STATUSES)[number];

export const MISSED_DAILY_COUNT_EXCEPTION_EVENTS = [
  "PROPOSED",
  "APPROVED",
  "REJECTED",
] as const;

export type MissedDailyCountExceptionEvent =
  (typeof MISSED_DAILY_COUNT_EXCEPTION_EVENTS)[number];

export const missedDailyCountExceptionStatusLabel: Record<
  MissedDailyCountExceptionStatus,
  string
> = {
  PENDING: "بانتظار المراجعة",
  APPROVED: "معتمد",
  REJECTED: "مرفوض",
};

export const MISSED_DAILY_COUNT_REASON_MIN = 15;
export const MISSED_DAILY_COUNT_REASON_MAX = 500;
export const MISSED_DAILY_COUNT_EVIDENCE_MIN = 5;
export const MISSED_DAILY_COUNT_EVIDENCE_MAX = 4_000;
