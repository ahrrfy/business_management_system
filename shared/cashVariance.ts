export const CASH_VARIANCE_SOURCE_TYPES = [
  "CUSTODY",
  "DAILY_TREASURY",
] as const;
export type CashVarianceSourceType =
  (typeof CASH_VARIANCE_SOURCE_TYPES)[number];

export const CASH_VARIANCE_REASON_CODES = [
  "COUNT_ERROR",
  "UNRECORDED_CASH_IN",
  "UNRECORDED_CASH_OUT",
  "CUSTODY_LOSS",
  "DOCUMENTATION_ERROR",
  "OTHER",
] as const;
export type CashVarianceReasonCode =
  (typeof CASH_VARIANCE_REASON_CODES)[number];

export const CASH_VARIANCE_REASON_LABELS: Record<
  CashVarianceReasonCode,
  string
> = {
  COUNT_ERROR: "خطأ عدّ موثّق",
  UNRECORDED_CASH_IN: "قبض نقدي غير مسجّل",
  UNRECORDED_CASH_OUT: "صرف نقدي غير مسجّل",
  CUSTODY_LOSS: "عجز في العهدة",
  DOCUMENTATION_ERROR: "خطأ في المستندات",
  OTHER: "سبب آخر",
};

export const CASH_VARIANCE_EVENT_TYPES = [
  "PROPOSED",
  "APPROVED",
  "REJECTED",
] as const;
export type CashVarianceEventType =
  (typeof CASH_VARIANCE_EVENT_TYPES)[number];

export const CASH_VARIANCE_COUNTER_ACCOUNT_POLICY = {
  CUSTODY: {
    SHORTAGE: "EMPLOYEE_ADVANCES",
    SURPLUS: "OTHER_LIABILITY",
  },
  DAILY_TREASURY: {
    SHORTAGE: "LOSSES",
    SURPLUS: "OTHER_LIABILITY",
  },
} as const;

export type CashVarianceType = "SHORTAGE" | "SURPLUS";

export const CASH_VARIANCE_LOCK_ORDER = [
  "FINANCIAL_GATE",
  "TREASURY_BRANCH",
  "SOURCE_DOCUMENT",
  "CASE",
  "RECEIPTS",
  "POSTING",
] as const;
