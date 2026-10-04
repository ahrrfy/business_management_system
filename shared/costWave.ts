/**
 * العقد المشترك لموجات التكلفة. الحساب هنا نقيّ ويُستعمل في المعاينة والخادم كي يكون
 * الرقم المعروض هو نفسه الرقم الذي يدخل مستند الاعتماد لاحقاً.
 */
import Decimal from "decimal.js";
export type CostWaveRuleType =
  | "SET_COST"
  | "INCREASE_AMOUNT"
  | "DECREASE_AMOUNT"
  | "INCREASE_PERCENT"
  | "DECREASE_PERCENT";

export type CostWavePurpose = "CORRECTION" | "IMPAIRMENT";
export type CostWaveScope = "FILTERED" | "SELECTED" | "ALL";
export type CostWaveStatus =
  | "PENDING_APPROVAL"
  | "APPLIED"
  | "REJECTED"
  | "CONFLICTED";
export const COST_WAVE_SKIP_REASONS = [
  "UNCHANGED",
  "NEGATIVE_RESULT",
  "INACTIVE",
  "NOT_FOUND",
  "SERVICE",
  "BUNDLE",
  "CONSIGNMENT",
  "NEGATIVE_STOCK",
  "IMPAIRMENT_INCREASE",
  "OPEN_GOVERNED_CHANGE",
] as const;
export type CostWaveSkipReason = (typeof COST_WAVE_SKIP_REASONS)[number];
export type CostWaveEventStage =
  | "SUBMITTED"
  | "APPROVAL_1"
  | "APPROVAL_2"
  | "APPLIED"
  | "REJECTED"
  | "CONFLICTED";

export const COST_WAVE_RULE_LABELS: Record<CostWaveRuleType, string> = {
  SET_COST: "تعيين تكلفة ثابتة",
  INCREASE_AMOUNT: "رفع التكلفة بمبلغ ثابت",
  DECREASE_AMOUNT: "خفض التكلفة بمبلغ ثابت",
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

export const COST_WAVE_EVENT_STAGE_LABELS: Record<
  CostWaveEventStage,
  string
> = {
  SUBMITTED: "أُرسلت للاعتماد",
  APPROVAL_1: "الاعتماد الأول",
  APPROVAL_2: "الاعتماد الثاني",
  APPLIED: "طُبّقت",
  REJECTED: "رُفضت",
  CONFLICTED: "تعارضت مع الواقع",
};

export const COST_WAVE_SKIP_LABELS: Record<CostWaveSkipReason, string> = {
  UNCHANGED: "لم تتغير بعد التقريب",
  NEGATIVE_RESULT: "سينتج تكلفة سالبة",
  INACTIVE: "الصنف أو المنتج غير نشط",
  NOT_FOUND: "الصنف لم يعد موجوداً",
  SERVICE: "منتج خدمي لا مخزون له",
  BUNDLE: "بكج تكلفته مشتقة من مكوّناته",
  CONSIGNMENT: "بضاعة أمانة ليست أصلاً مملوكاً",
  NEGATIVE_STOCK: "رصيد سالب يحتاج معالجة قبل التقييم",
  IMPAIRMENT_INCREASE: "التكلفة المستهدفة ترفع القيمة في غرض هبوط القيمة",
  OPEN_GOVERNED_CHANGE: "له طلب تكلفة أو موجة معلقة",
};

export const COST_WAVE_REQUIRED_APPROVALS = 2;
export const COST_WAVE_MIN_REASON_LENGTH = 10;
export const COST_WAVE_MAX_REASON_LENGTH = 1_000;
/** حد تشغيلي محافظ إلى أن يصبح الترحيل الجماعي دفعاتٍ حقيقيةً لا حلقة قيود متسلسلة. */
export const COST_WAVE_MAX_ITEMS = 250;
export const COST_WAVE_MAX_SELECTED_ITEMS = COST_WAVE_MAX_ITEMS;
export const COST_WAVE_MAX_PERCENT = 1_000;

export interface CostWaveRule {
  ruleType: CostWaveRuleType;
  /** نص رقمي؛ لا يُحوَّل إلى float في أي طبقة. */
  changeValue: string;
}

export interface CostWaveRuleOutcome {
  newCost: string | null;
  skipReason: "UNCHANGED" | "NEGATIVE_RESULT" | null;
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
    case "INCREASE_AMOUNT":
      raw = oldValue.plus(change);
      break;
    case "DECREASE_AMOUNT":
      raw = oldValue.minus(change);
      break;
    case "INCREASE_PERCENT":
      raw = oldValue.mul(hundred.plus(change)).div(hundred);
      break;
    case "DECREASE_PERCENT":
      raw = oldValue.mul(hundred.minus(change)).div(hundred);
      break;
  }

  const next = raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (next.isNegative()) {
    return { newCost: null, skipReason: "NEGATIVE_RESULT" };
  }
  if (next.equals(oldValue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP))) {
    return { newCost: null, skipReason: "UNCHANGED" };
  }
  return { newCost: next.toFixed(2), skipReason: null };
}
