/**
 * العقد المشترك لموجات التكلفة. الحساب هنا نقيّ ويُستعمل في المعاينة والخادم كي يكون
 * الرقم المعروض هو نفسه الرقم الذي يدخل مستند الاعتماد لاحقاً.
 */
import Decimal from "decimal.js";
export type CostWaveRuleType =
  | "SET_COST"
  | "INCREASE_PERCENT"
  | "DECREASE_PERCENT";

export type CostWavePurpose = "CORRECTION" | "IMPAIRMENT";
export type CostWaveScope = "FILTERED" | "SELECTED" | "ALL";
export type CostWaveStatus =
  | "PENDING_APPROVAL"
  | "APPLIED"
  | "REJECTED"
  | "CONFLICTED";
export type CostWaveEventStage =
  | "SUBMITTED"
  | "APPROVAL_1"
  | "APPROVAL_2"
  | "APPLIED"
  | "REJECTED"
  | "CONFLICTED";

export const COST_WAVE_RULE_LABELS: Record<CostWaveRuleType, string> = {
  SET_COST: "تعيين تكلفة ثابتة",
  INCREASE_PERCENT: "رفع التكلفة بنسبة (%)",
  DECREASE_PERCENT: "خفض التكلفة بنسبة (%)",
};

export const COST_WAVE_PURPOSE_LABELS: Record<CostWavePurpose, string> = {
  CORRECTION: "تصحيح تكلفة خاطئة",
  IMPAIRMENT: "هبوط قيمة المخزون",
};

export const COST_WAVE_SCOPE_LABELS: Record<CostWaveScope, string> = {
  FILTERED: "بالفلاتر (فئة/بحث)",
  SELECTED: "أصناف محددة يدوياً",
  ALL: "كل الأصناف المؤهلة",
};

export const COST_WAVE_STATUS_LABELS: Record<CostWaveStatus, string> = {
  PENDING_APPROVAL: "بانتظار الاعتماد",
  APPLIED: "طُبّقت",
  REJECTED: "مرفوضة",
  CONFLICTED: "تعارضت مع الواقع",
};

export const COST_WAVE_REQUIRED_APPROVALS = 2;
export const COST_WAVE_MIN_REASON_LENGTH = 10;
export const COST_WAVE_MAX_ITEMS = 5_000;
export const COST_WAVE_MAX_PERCENT = 1_000;

export interface CostWaveRule {
  ruleType: CostWaveRuleType;
  /** نص رقمي؛ لا يُحوَّل إلى float في أي طبقة. */
  changeValue: string;
}

export interface CostWaveRuleOutcome {
  newCost: string | null;
  skipReason: "UNCHANGED" | null;
}

/**
 * احسب التكلفة الجديدة بدقة Decimal ثم قرّب عند حدّ التخزين فقط (منزلتان، HALF_UP).
 * التحقق من الغرض والحدود مسؤولية الخدمة لأنّه يحتاج سياق المستند كله.
 */
export function applyCostWaveRule(
  oldCost: string | number | Decimal,
  rule: CostWaveRule,
): CostWaveRuleOutcome {
  const oldValue = new Decimal(oldCost);
  const change = new Decimal(rule.changeValue);
  const hundred = new Decimal(100);
  let raw: Decimal;

  switch (rule.ruleType) {
    case "SET_COST":
      raw = change;
      break;
    case "INCREASE_PERCENT":
      raw = oldValue.mul(hundred.plus(change)).div(hundred);
      break;
    case "DECREASE_PERCENT":
      raw = oldValue.mul(hundred.minus(change)).div(hundred);
      break;
  }

  const next = raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (next.equals(oldValue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP))) {
    return { newCost: null, skipReason: "UNCHANGED" };
  }
  return { newCost: next.toFixed(2), skipReason: null };
}
