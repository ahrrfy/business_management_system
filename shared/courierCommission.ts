/**
 * حسابُ عمولة جهة التوصيل من قواعد `courierCommissionRules` — نقيّةٌ عميلاً وخادماً.
 *
 * الأنماط المدعومة (Slice 8، ٢٨/٨/٢٦، هجرة 0280):
 *   • `FLAT_PER_DELIVERY`  — flatAmount لكلّ إرساليّة (أشيع نموذج في العراق).
 *   • `PERCENT_OF_FEE`     — percentValue% من أجرة التوصيل نفسها.
 *   • `PERCENT_OF_ORDER`   — percentValue% من قيمة الطلب المُحصَّل (COD).
 *   • `HYBRID`             — flatAmount + (percentValue% × أجرة التوصيل).
 *
 * `minGuarantee`/`maxCap` تُطبَّق بعد الحساب. الاختيار: أوّلُ قاعدةٍ نشطة (تصميم قاعدةٍ لكلّ جهة).
 *
 * ⚠️ لا استهلاكَ ماليٌّ في هذه الشريحة — الدالّة جاهزةٌ لاستعمالٍ لاحق (auto-posting/auto-settlement).
 */

export interface CourierCommissionRuleInput {
  id: number;
  ruleType: string;
  flatAmount?: string | number | null;
  percentValue?: string | number | null;
  minGuarantee?: string | number | null;
  maxCap?: string | number | null;
  isActive: boolean;
}

export interface CommissionContext {
  /** أجرة التوصيل المستحقّة على الطلب (deliveryFee على الفاتورة). */
  deliveryFee?: number | null;
  /** إجماليّ الطلب المحصَّل (invoice.total) — لـPERCENT_OF_ORDER. */
  orderTotal?: number | null;
}

export interface CommissionQuote {
  commission: number;
  ruleId: number;
  breakdown: {
    flatPart?: number;
    percentPart?: number;
    minApplied?: boolean;
    maxApplied?: boolean;
  };
}

const toNum = (v: string | number | null | undefined): number => {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function computeCourierCommission(
  rules: CourierCommissionRuleInput[],
  ctx: CommissionContext = {},
): CommissionQuote | null {
  const active = rules.filter((r) => r.isActive);
  if (active.length === 0) return null;
  const rule = active[0]!;

  const flat = toNum(rule.flatAmount);
  const pct = toNum(rule.percentValue);
  const fee = toNum(ctx.deliveryFee);
  const orderTotal = toNum(ctx.orderTotal);

  let commission = 0;
  const breakdown: CommissionQuote["breakdown"] = {};

  switch (rule.ruleType) {
    case "FLAT_PER_DELIVERY":
      commission = flat;
      breakdown.flatPart = flat;
      break;
    case "PERCENT_OF_FEE": {
      const p = (pct / 100) * fee;
      commission = p;
      breakdown.percentPart = p;
      break;
    }
    case "PERCENT_OF_ORDER": {
      const p = (pct / 100) * orderTotal;
      commission = p;
      breakdown.percentPart = p;
      break;
    }
    case "HYBRID": {
      const p = (pct / 100) * fee;
      commission = flat + p;
      breakdown.flatPart = flat;
      breakdown.percentPart = p;
      break;
    }
    default:
      // نوعٌ مجهول ⇒ نرجع null بدل احتساب صامتٍ خاطئ.
      return null;
  }

  // الحدّ الأدنى المضمون للمندوب — يُبقي الاحتساب عادلاً على السلال الصغيرة.
  const minG = rule.minGuarantee != null ? toNum(rule.minGuarantee) : null;
  if (minG != null && commission < minG) {
    commission = minG;
    breakdown.minApplied = true;
  }

  // السقف — يحمي المكتبة في الطلبات الكبيرة (خصوصاً PERCENT_OF_ORDER).
  const maxC = rule.maxCap != null ? toNum(rule.maxCap) : null;
  if (maxC != null && commission > maxC) {
    commission = maxC;
    breakdown.maxApplied = true;
  }

  return { commission, ruleId: rule.id, breakdown };
}
