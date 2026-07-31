// نموذج «المثال التعليمي» لخطط العمولات — دوال نقيّة تحاكي محرّك الخادم حرفياً
// (server/services/commissions/engine.ts → applyPlanTier + computeCommissionRun) كي لا يكذب
// المثال على المستخدم: نفس ترتيب المستويات، نفس اختيار المستوى، نفس التقريب.
//
// ⚠️ عرضٌ فقط — لا يُرسَل أي رقم من هنا إلى أي mutation. الخادم يحتسب مصدرَ الحقيقة.
import { D, round2 } from "@/lib/money";

export type TierMode = "TARGET_PCT" | "AMOUNT_SLAB";

export interface ExampleTier {
  /** الحدّ الأدنى: نسبة تحقيق الهدف (TARGET_PCT) أو مبلغ مبيعات (AMOUNT_SLAB). */
  threshold: string;
  ratePct: string;
  fixedBonus: string;
}

export interface ExampleInput {
  tierMode: TierMode;
  tiers: ExampleTier[];
  /** صافي مبيعات الموظف في الشهر (بعد المرتجعات) — سالبها يُعامَل صفراً كالمحرّك. */
  sales: string;
  /** الهدف الشهري — يُستعمَل في نمط TARGET_PCT فقط. */
  target: string;
}

export interface ExampleResult {
  /** المبلغ المحتسَب عليه = max(0, صافي المبيعات) — نظير effectiveBase في المحرّك. */
  base: string;
  /** نسبة تحقيق الهدف (٢ منزلة) أو null حين لا هدف/الهدف صفر. */
  achievementPct: string | null;
  /** ترتيب المستوى المطبَّق ضمن المستويات المرتّبة تصاعدياً (1-based) أو null. */
  tierRank: number | null;
  tier: ExampleTier | null;
  /** ناتج النسبة وحدها (قبل المكافأة). */
  ratePart: string;
  fixedBonus: string;
  commission: string;
  /** خطة «نسبة تحقيق الهدف» بلا هدف ⇒ صفر عمولة (نفس سلوك المحرّك). */
  noTarget: boolean;
}

/** ترتيب المستويات تصاعدياً بالحدّ — يطابق `ORDER BY threshold ASC` في loadPlans. */
export function sortTiers(tiers: ExampleTier[]): ExampleTier[] {
  return [...tiers].sort((a, b) => D(a.threshold).comparedTo(D(b.threshold)));
}

/** آخر مستوى حدُّه ≤ المقياس — نظير حلقة applyPlanTier حرفياً. null إن لم يُبلَغ أيٌّ منها. */
export function pickTierRank(sorted: ExampleTier[], measure: string | null): number | null {
  if (measure == null) return null;
  const m = D(measure);
  let rank: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if (D(sorted[i].threshold).lte(m)) rank = i + 1;
  }
  return rank;
}

/** احتساب مثال كامل بأرقام المستخدم — مرآة سطر واحد من تشغيلة العمولة. */
export function computeExample(input: ExampleInput): ExampleResult {
  const sorted = sortTiers(input.tiers.filter((t) => t.threshold.trim() !== "" && t.ratePct.trim() !== ""));
  const rawBase = D(input.sales);
  const base = rawBase.isNegative() ? D(0) : rawBase;
  const target = D(input.target);

  const hasTarget = target.gt(0);
  const achievementPct = hasTarget ? round2(base.div(target).times(100)) : null;
  const noTarget = input.tierMode === "TARGET_PCT" && !hasTarget;

  const measure =
    input.tierMode === "TARGET_PCT"
      ? achievementPct != null
        ? achievementPct.toFixed(2)
        : null
      : base.toFixed(2);

  const rank = pickTierRank(sorted, measure);
  const tier = rank != null ? sorted[rank - 1] : null;

  // نظير المحرّك: round2(base × rate / 100) + fixedBonus.
  const ratePart = tier ? round2(base.times(D(tier.ratePct)).div(100)) : D(0);
  const fixedBonus = tier ? D(tier.fixedBonus) : D(0);

  return {
    base: base.toFixed(2),
    achievementPct: achievementPct != null ? achievementPct.toFixed(2) : null,
    tierRank: rank,
    tier,
    ratePart: ratePart.toFixed(2),
    fixedBonus: round2(fixedBonus).toFixed(2),
    commission: round2(ratePart.plus(fixedBonus)).toFixed(2),
    noTarget,
  };
}
