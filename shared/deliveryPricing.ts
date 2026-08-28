/**
 * حسابُ أجرة التوصيل من قواعد `deliveryPricingRules` — الحسابيّة نقيّةٌ عميلاً وخادماً.
 *
 * الأنماط المدعومة الآن (Slice 7، ٢٨/٨/٢٦، هجرة 0279):
 *   • `FLAT_FEE`   — رسمٌ ثابتٌ للمنطقة (النمط المشروع الوحيد في البذرة).
 *   • `PER_KM`     — baseFee + (perKmFee × كم). ⚙️ الحقلُ مُهيَّأ في المخطّط، غيرُ مُستَعمل بعد.
 *   • `WEIGHT`     — baseFee + (perKgFee × كغم). نفس الوضع.
 *
 * قواعدُ الحدود: `minFee`/`maxFee` اختياريّة — تُطبَّق بعد الحساب لِتُقصى الطرفيّة.
 *
 * **fallback:** إن لم يجد قاعدةً نشطة، يُرجع `null` — على المستهلك عرض الرجوع لـ`governorates.ts`
 * (السلوك القديم) أو رفض الطلب صراحةً بدل تسعيرٍ صامتٍ خاطئ.
 */

export interface DeliveryPricingRuleInput {
  id: number;
  ruleType: string;
  baseFee: string | number;
  perKmFee?: string | number | null;
  perKgFee?: string | number | null;
  minFee?: string | number | null;
  maxFee?: string | number | null;
  isActive: boolean;
}

export interface DeliveryQuoteContext {
  distanceKm?: number | null;
  weightKg?: number | null;
}

export interface DeliveryQuote {
  fee: number;
  ruleId: number;
  breakdown: {
    baseFee: number;
    distanceFee?: number;
    weightFee?: number;
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

/**
 * يحسبُ أجرةَ التوصيل من أوّل قاعدةٍ نشطة (بترتيب الإدراج). إن لم توجد قاعدةٌ نشطةٌ ⇒ null.
 * القاعدةُ الأولى تكفي: التصميم قاعدةٌ واحدةٌ لكلّ (zoneId × ruleType). إن تُعدَّدت مستقبلاً
 * فالمنطق يُوسَّع لاختيار الأنسب.
 */
export function computeDeliveryFee(
  rules: DeliveryPricingRuleInput[],
  ctx: DeliveryQuoteContext = {},
): DeliveryQuote | null {
  const active = rules.filter((r) => r.isActive);
  if (active.length === 0) return null;
  const rule = active[0]!;

  const baseFee = toNum(rule.baseFee);
  let fee = baseFee;
  const breakdown: DeliveryQuote["breakdown"] = { baseFee };

  if (rule.ruleType === "PER_KM" && ctx.distanceKm != null && ctx.distanceKm > 0) {
    const distanceFee = toNum(rule.perKmFee) * ctx.distanceKm;
    fee += distanceFee;
    breakdown.distanceFee = distanceFee;
  }

  if (rule.ruleType === "WEIGHT" && ctx.weightKg != null && ctx.weightKg > 0) {
    const weightFee = toNum(rule.perKgFee) * ctx.weightKg;
    fee += weightFee;
    breakdown.weightFee = weightFee;
  }

  // الحدّ الأدنى — تُبقي الأجرة موجبة معنويّاً حتى لو حسابها ناقص.
  const minFee = rule.minFee != null ? toNum(rule.minFee) : null;
  if (minFee != null && fee < minFee) {
    fee = minFee;
    breakdown.minApplied = true;
  }

  // السقف — يحمي العميل من انفلاتٍ (مثلاً PER_KM في مسافةٍ خطأ).
  const maxFee = rule.maxFee != null ? toNum(rule.maxFee) : null;
  if (maxFee != null && fee > maxFee) {
    fee = maxFee;
    breakdown.maxApplied = true;
  }

  return { fee, ruleId: rule.id, breakdown };
}
