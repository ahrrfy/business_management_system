export const CASH_VARIANCE_SOURCE_TYPES = [
  "CUSTODY",
  "DAILY_TREASURY",
] as const;
export type CashVarianceSourceType =
  (typeof CASH_VARIANCE_SOURCE_TYPES)[number];

export const CASH_VARIANCE_EVIDENCE_REFERENCE_MIN_LENGTH = 5;
export const CASH_VARIANCE_EVIDENCE_REFERENCE_MAX_LENGTH = 2_000;
export const CASH_VARIANCE_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const CASH_VARIANCE_EVIDENCE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
] as const;

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

/**
 * الأسباب الصالحة لكل مصدر. «عجز العهدة» يحمّل ذمةً على صاحب عهدةٍ موثّق،
 * لذلك لا يجوز استعماله لمطابقة الخزينة اليومية التي لا تحمل عقد حيازة شخصياً.
 */
export const CASH_VARIANCE_REASON_CODES_BY_SOURCE = {
  CUSTODY: CASH_VARIANCE_REASON_CODES,
  DAILY_TREASURY: [
    "COUNT_ERROR",
    "UNRECORDED_CASH_IN",
    "UNRECORDED_CASH_OUT",
    "DOCUMENTATION_ERROR",
    "OTHER",
  ],
} as const satisfies Record<
  CashVarianceSourceType,
  readonly CashVarianceReasonCode[]
>;

export function isCashVarianceReasonAllowed(
  sourceType: CashVarianceSourceType,
  reasonCode: CashVarianceReasonCode,
): boolean {
  return (CASH_VARIANCE_REASON_CODES_BY_SOURCE[sourceType] as readonly CashVarianceReasonCode[])
    .includes(reasonCode);
}

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
