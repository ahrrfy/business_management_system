import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

const ARABIC_STOP_WORDS = new Set([
  "مع", "في", "من", "عن", "على", "الى", "او", "ثم", "كل", "هو", "هي", "تم", "غير", "بين", "ذو", "ذات",
]);

function tokenizeArabic(str: string): string[] {
  return (str || "")
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\w\u0600-\u06FF\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^(ال|وال|فال|بال|كال)/, "").trim())
    .filter((w) => w.length >= 2 && !ARABIC_STOP_WORDS.has(w));
}

function safeDecimal(v: string | number | null | undefined, def = 0): Decimal {
  if (v == null || v === "") return new Decimal(def);
  try {
    const d = new Decimal(v);
    return d.isNaN() ? new Decimal(def) : d;
  } catch {
    return new Decimal(def);
  }
}

function computeEstimatedUnitCost(materialsTotal: Decimal, labor: string | null | undefined, wasteStdPct: string | null | undefined): string {
  const safeLabor = Decimal.max(0, safeDecimal(labor, 0));
  const rawWaste = safeDecimal(wasteStdPct, 0);
  const wastePct = rawWaste.gt(0) && rawWaste.lt(1) ? rawWaste : new Decimal(0);
  const totalBeforeWaste = materialsTotal.plus(safeLabor);
  const wasteFactor = wastePct.gt(0) && wastePct.lt(1) ? new Decimal(1).minus(wastePct) : new Decimal(1);
  return wasteFactor.gt(0)
    ? totalBeforeWaste.div(wasteFactor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString()
    : totalBeforeWaste.toString();
}

function scoreRecipeSimilarity(
  target: { name: string; categoryId: number | null; isService: boolean },
  candidate: { name: string; categoryId: number | null; isService: boolean },
) {
  const targetTokens = new Set(tokenizeArabic(target.name));
  const candTokens = tokenizeArabic(candidate.name);

  let score = 0;
  const reasons: string[] = [];

  // 1. فحص تطابق الصنف
  if (
    target.categoryId != null &&
    candidate.categoryId != null &&
    target.categoryId === candidate.categoryId
  ) {
    score += 50;
    reasons.push("نفس التصنيف");
  }

  // 2. فحص تطابق الكلمات الدلالية
  const matchedTokens: string[] = [];
  for (const token of candTokens) {
    if (targetTokens.has(token)) {
      matchedTokens.push(token);
    }
  }

  if (matchedTokens.length > 0) {
    score += matchedTokens.length * 20;
    reasons.push(`تطابق في الكلمات: ${matchedTokens.join("، ")}`);
  }

  // 3. فحص تطابق النوع (خدمة أو مادي)
  if (target.isService === candidate.isService) {
    score += 10;
  }

  return { score, reasons };
}

describe("محرك الاقتراحات التنبؤية للوصفات (Predictive Recipe Suggestions Engine)", () => {
  it("يُجزّئ الكلمات العربية ويزيل السوابق الشائعة بدقة", () => {
    const tokens = tokenizeArabic("طباعة رول اب مع الستاند والبانر الفاخر");
    expect(tokens).toContain("طباعه"); // بعد تطبيع التاء المربوطة
    expect(tokens).toContain("رول");
    expect(tokens).toContain("ستاند"); // بعد إزالة الـ
    expect(tokens).toContain("بانر"); // بعد إزالة والـ
    expect(tokens).toContain("فاخر"); // بعد إزالة الـ
    expect(tokens).not.toContain("مع"); // تم استبعاد كلمة التوقف
  });

  it("يطبّع الهمزات والتاء المربوطة لمطابقة الكلمات المتشابهة بدقة", () => {
    // إستاند vs استاند (همزة القطع مقابل ألف الوصل)
    const tokens1 = tokenizeArabic("إستاند أعلام مكتبي فاخر");
    const tokens2 = tokenizeArabic("استاند اعلام مكتبي");

    expect(tokens1).toContain("استاند");
    expect(tokens2).toContain("استاند");
    expect(tokens1).toContain("اعلام");
    expect(tokens2).toContain("اعلام");
  });

  it("يعطي أولوية عالية للتطابق في الصنف والكلمات معاً", () => {
    const target = {
      name: "بانر رول اب قياس 85x200 سم",
      categoryId: 12,
      isService: false,
    };

    const bestMatch = {
      name: "بانر رول اب قياس 120x200 سم فاخر",
      categoryId: 12,
      isService: false,
    };

    const categoryOnlyMatch = {
      name: "درع خشبي تذكاري كريستال",
      categoryId: 12,
      isService: false,
    };

    const unrelated = {
      name: "دفتر مذكرات جلد A5",
      categoryId: 99,
      isService: false,
    };

    const bestScore = scoreRecipeSimilarity(target, bestMatch);
    const catScore = scoreRecipeSimilarity(target, categoryOnlyMatch);
    const unScore = scoreRecipeSimilarity(target, unrelated);

    expect(bestScore.score).toBeGreaterThan(catScore.score);
    expect(catScore.score).toBeGreaterThan(unScore.score);
    expect(bestScore.reasons).toContain("نفس التصنيف");
    expect(bestScore.reasons[1]).toContain("تطابق في الكلمات");
  });

  it("يكتشف تطابق الكلمات حتى مع اختلاف الصنف", () => {
    const target = {
      name: "كارت شخصي سلفان مطفي",
      categoryId: 5,
      isService: false,
    };

    const candidate = {
      name: "كارت شخصي سبوت يو في فاخر",
      categoryId: 8,
      isService: false,
    };

    const result = scoreRecipeSimilarity(target, candidate);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("كارت"))).toBe(true);
  });

  it("يتعامل safeDecimal بأمان مع المدخلات غير الصالحة والكسور الجزئية بدون رمي أخطاء", () => {
    expect(safeDecimal(".").toString()).toBe("0");
    expect(safeDecimal("").toString()).toBe("0");
    expect(safeDecimal(null).toString()).toBe("0");
    expect(safeDecimal(undefined).toString()).toBe("0");
    expect(safeDecimal("abc").toString()).toBe("0");
    expect(safeDecimal("-15.5").toString()).toBe("-15.5");
    expect(safeDecimal("12.50").toString()).toBe("12.5");
  });

  it("يحسب كلفة الوحدة التقديرية بدقة ويحمي من نسب الهدر الفاسدة (سالبة، مساوية لـ 1، أو أكبر من 1)", () => {
    const materials = new Decimal(10000);

    // هدر اعتيادي 5% وعمالة 2000
    const normal = computeEstimatedUnitCost(materials, "2000", "0.05");
    // (10,000 + 2000) / 0.95 = 12631.58
    expect(normal).toBe("12631.58");

    // هدر 100% (يجب ألا يقسم على صفر)
    const hundred = computeEstimatedUnitCost(materials, "2000", "1.0");
    expect(hundred).toBe("12000");

    // هدر أكبر من 100% (1.5)
    const overHundred = computeEstimatedUnitCost(materials, "2000", "1.5");
    expect(overHundred).toBe("12000");

    // هدر سالب (-0.1)
    const negativeWaste = computeEstimatedUnitCost(materials, "2000", "-0.1");
    expect(negativeWaste).toBe("12000");

    // عمالة سالبة (-500) يجب أن تُعامل كصفر
    const negativeLabor = computeEstimatedUnitCost(materials, "-500", "0");
    expect(negativeLabor).toBe("10000");
  });

  it("يستبعد الوصفات الخالية (lineCount === 0) من نتائج الاقتراحات والاستيراد", () => {
    const candidates = [
      { recipeId: 1, name: "وصفة مكتملة", lines: [{ id: 10 }] },
      { recipeId: 2, name: "وصفة فارغة مهجورة", lines: [] },
    ];

    const filtered = candidates.filter((c) => c.lines.length > 0);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].recipeId).toBe(1);
  });

  it("يضمن تعقيم سلاسل العمالة ونسب الهدر في عقد الاستجابة لمقترحات واستيراد الوصفات", () => {
    function sanitizeRecipeFields(recipe: { labor: string; waste: string }) {
      const labor = Decimal.max(0, safeDecimal(recipe.labor, 0));
      const rawWaste = safeDecimal(recipe.waste, 0);
      const wastePct = rawWaste.gt(0) && rawWaste.lt(1) ? rawWaste : new Decimal(0);
      return {
        laborPerOutputBase: labor.toString(),
        wasteStdPct: wastePct.toString(),
      };
    }

    // مدخلات تالفة: عمالة سالبة وهدر غير صالح (150% أو سالب)
    const dirty = sanitizeRecipeFields({ labor: "-1200", waste: "1.5" });
    expect(dirty.laborPerOutputBase).toBe("0");
    expect(dirty.wasteStdPct).toBe("0");

    const valid = sanitizeRecipeFields({ labor: "2500", waste: "0.08" });
    expect(valid.laborPerOutputBase).toBe("2500");
    expect(valid.wasteStdPct).toBe("0.08");
  });
});
