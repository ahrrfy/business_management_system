import { describe, it, expect } from "vitest";
import {
  ABS_MAX_MONEY_IQD,
  ABS_MAX_CONVERSION_FACTOR,
  parseMoneyStr,
  checkMoneyBounds,
  checkConversionFactor,
  checkCostVsRetail,
  checkVariantSanity,
  classifySeverity,
  suggestCostCorrections,
} from "./priceSanity";

describe("parseMoneyStr", () => {
  it("يحوّل السلسلة الرقمية إلى عدد", () => {
    expect(parseMoneyStr("150")).toBe(150);
    expect(parseMoneyStr("1162.5")).toBe(1162.5);
    expect(parseMoneyStr("0")).toBe(0);
  });
  it("يُرجع null للفارغ/غير الرقميّ", () => {
    expect(parseMoneyStr("")).toBeNull();
    expect(parseMoneyStr(null)).toBeNull();
    expect(parseMoneyStr(undefined)).toBeNull();
    expect(parseMoneyStr("-")).toBeNull();
    expect(parseMoneyStr("abc")).toBeNull();
  });
  it("يُشذّب المسافات", () => {
    expect(parseMoneyStr("  150  ")).toBe(150);
  });
});

describe("checkMoneyBounds", () => {
  it("يقبل قيماً معقولة بلا ملاحظات", () => {
    expect(checkMoneyBounds("150", "costPrice", "التكلفة")).toHaveLength(0);
    expect(checkMoneyBounds("0", "costPrice", "التكلفة")).toHaveLength(0);
    expect(checkMoneyBounds("", "costPrice", "التكلفة")).toHaveLength(0);
    expect(checkMoneyBounds(null, "costPrice", "التكلفة")).toHaveLength(0);
  });
  it("يرفض السالب كـblocker", () => {
    const r = checkMoneyBounds("-10", "costPrice", "التكلفة");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("blocker");
    expect(r[0].code).toBe("money_negative");
  });
  it("يرفض تجاوز الحدّ المطلق كـblocker", () => {
    const r = checkMoneyBounds(String(ABS_MAX_MONEY_IQD + 1), "costPrice", "التكلفة");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("blocker");
    expect(r[0].code).toBe("money_over_absmax");
  });
});

describe("checkConversionFactor", () => {
  it("لا يفحص وحدة الأساس", () => {
    expect(checkConversionFactor("1", true)).toHaveLength(0);
    expect(checkConversionFactor("999999", true)).toHaveLength(0);
  });
  it("يرفض الغائب/صفر لغير الأساس", () => {
    const r1 = checkConversionFactor("", false);
    const r0 = checkConversionFactor("0", false);
    expect(r1[0].code).toBe("factor_missing");
    expect(r0[0].code).toBe("factor_missing");
  });
  it("يرفض ≤ ١ لغير الأساس", () => {
    const r = checkConversionFactor("1", false);
    expect(r[0].level).toBe("blocker");
    expect(r[0].code).toBe("factor_le_one");
  });
  it("يقبل معاملاً معقولاً بلا ملاحظات", () => {
    expect(checkConversionFactor("12", false)).toHaveLength(0);
    expect(checkConversionFactor("500", false)).toHaveLength(0);
    expect(checkConversionFactor("2500", false)).toHaveLength(0);
  });
  it("يُنبّه بشدّةٍ على تجاوز الحدّ الأقصى (warning)", () => {
    const r = checkConversionFactor(String(ABS_MAX_CONVERSION_FACTOR + 1), false);
    expect(r[0].level).toBe("warning");
    expect(r[0].code).toBe("factor_over_max");
  });
});

describe("checkCostVsRetail — قلب التشخيص", () => {
  it("يقبل التكلفة < السعر بلا ملاحظات", () => {
    expect(checkCostVsRetail("100", "500", "المفرد")).toHaveLength(0);
    expect(checkCostVsRetail("1162.5", "2000", "المفرد")).toHaveLength(0);
  });
  it("يُنبّه على البيع بخسارة (warning) — التكلفة > السعر بقليل", () => {
    const r = checkCostVsRetail("2500", "2000", "المفرد");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("warning");
    expect(r[0].code).toBe("cost_over_retail");
  });
  it("يحجب حجباً قاطعاً (blocker) — التكلفة > السعر بـ٥× أو أكثر (كالحادثة الفعلية)", () => {
    // الحادثة: cost=16162 vs retail=2000 → 8× → blocker
    const r = checkCostVsRetail("16162", "2000", "المفرد");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("blocker");
    expect(r[0].code).toBe("cost_over_retail_hard");
  });
  it("يُلاحظ الهامش الضيّق جداً (info)", () => {
    // ratio 0.96 = 5% margin → NARROW_MARGIN_RATIO gate
    const r = checkCostVsRetail("960", "1000", "المفرد");
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe("info");
    expect(r[0].code).toBe("narrow_margin");
  });
  it("يتجاهل الحالات الفارغة/الصفرية بأمان", () => {
    expect(checkCostVsRetail("", "500", "المفرد")).toHaveLength(0);
    expect(checkCostVsRetail("100", "", "المفرد")).toHaveLength(0);
    expect(checkCostVsRetail("0", "500", "المفرد")).toHaveLength(0);
    expect(checkCostVsRetail("100", "0", "المفرد")).toHaveLength(0);
  });
});

describe("checkVariantSanity — التركيب النهائي", () => {
  it("متغيّرٌ سليم بلا ملاحظات", () => {
    const r = checkVariantSanity("100", [
      { unitName: "قطعة", conversionFactor: 1, retail: "500", wholesale: "450", government: "400" },
      { unitName: "درزن", conversionFactor: 12, retail: "5500", wholesale: null, government: null },
    ]);
    expect(r).toHaveLength(0);
  });

  it("يُمسك حادثة SINARLINE الفعلية (cost 16162 vs retail 2000) كـblocker", () => {
    const r = checkVariantSanity("16162", [
      { unitName: "قطعة", conversionFactor: 1, retail: "2000", wholesale: null, government: null },
    ]);
    const blockers = r.filter((i) => i.level === "blocker");
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.some((i) => i.code === "cost_over_retail_hard")).toBe(true);
  });

  it("يُمسك حادثة كارتون A4 (cost 8.20/قطعة × 2500 = 20500 vs retail كارتون 24000): هامش معقول لا ملاحظة قاطعة", () => {
    const r = checkVariantSanity("8.20", [
      { unitName: "قطعة", conversionFactor: 1, retail: "125", wholesale: null, government: null },
      { unitName: "رزمة", conversionFactor: 500, retail: "5000", wholesale: null, government: null },
      { unitName: "كارتون", conversionFactor: 2500, retail: "24000", wholesale: null, government: null },
    ]);
    // 20500 vs 24000 = 85% margin → NOT triggering narrow_margin (needs < 5%)
    expect(r.filter((i) => i.level === "blocker" || i.level === "warning")).toHaveLength(0);
  });

  it("يرتّب: blocker → warning → info", () => {
    const r = checkVariantSanity("100", [
      { unitName: "قطعة", conversionFactor: 1, retail: "600", wholesale: "50", government: "20" },
      // 100 vs 600 = OK للمفرد؛ 100 vs 50 = warning (بيع بخسارة على الجملة)؛ 100 vs 20 = blocker (5×)
    ]);
    const levels = r.map((i) => i.level);
    // كل blocker يجب أن يأتي قبل أيّ warning، وهكذا…
    for (let i = 1; i < levels.length; i++) {
      const order = { blocker: 0, warning: 1, info: 2 };
      expect(order[levels[i - 1]]).toBeLessThanOrEqual(order[levels[i]]);
    }
  });

  it("يرفض معاملاً عارياً (0) على غير الأساس مع رسالةٍ توضّح الوحدة", () => {
    const r = checkVariantSanity("100", [
      { unitName: "قطعة", conversionFactor: 1, retail: "500", wholesale: null, government: null },
      { unitName: "كارتون", conversionFactor: 0, retail: "50000", wholesale: null, government: null },
    ]);
    const factorIssue = r.find((i) => i.code === "factor_missing");
    expect(factorIssue?.message).toContain("كارتون");
  });
});

describe("classifySeverity — تدرّج الحدّة (٤ مستويات)", () => {
  it("catastrophic عند ≥ ١٠× سعر البيع", () => {
    expect(classifySeverity(20000, { retail: 2000 })).toBe("catastrophic");
    expect(classifySeverity(16162, { retail: 2000 })).toBe("blocker"); // ٨.٠٨× — دون العشرة
  });
  it("catastrophic عند ≥ ١٠× القيمة السابقة", () => {
    expect(classifySeverity(11000, { oldCost: 1000 })).toBe("catastrophic");
  });
  it("blocker عند ٥× ≤ ratio < ١٠×", () => {
    expect(classifySeverity(10000, { retail: 2000 })).toBe("blocker");
    expect(classifySeverity(5000, { retail: 1000 })).toBe("blocker");
  });
  it("warning عند البيع بخسارة (١× < ratio < ٥×)", () => {
    expect(classifySeverity(2500, { retail: 2000 })).toBe("warning");
  });
  it("info عند الهامش الضيّق (٥٪ أو أقل)", () => {
    expect(classifySeverity(960, { retail: 1000 })).toBe("info");
  });
  it("ok عند الهامش الصحّي", () => {
    expect(classifySeverity(500, { retail: 2000 })).toBe("ok");
  });
  it("يأخذ الأشدّ بين المقياسَين (retail و oldCost)", () => {
    // ratio مقابل retail = ٦ (blocker)، ratio مقابل oldCost = ١٥ (catastrophic) ⇒ الأشدّ
    expect(classifySeverity(15000, { retail: 2500, oldCost: 1000 })).toBe("catastrophic");
  });
  it("يتجاهل المرجع الفارغ/الصفر", () => {
    expect(classifySeverity(500, { retail: 0 })).toBe("ok");
    expect(classifySeverity(500, {})).toBe("ok");
  });
});

describe("suggestCostCorrections — اقتراحات ذكية", () => {
  it("يقترح 1162 لحالة SINARLINE (تكلفة 16162 vs بيع 2000) — الأقرب لـ retail×0.5=1000", () => {
    const suggs = suggestCostCorrections(16162, 2000);
    expect(suggs.length).toBeGreaterThan(0);
    expect(suggs.length).toBeLessThanOrEqual(3);
    const values = suggs.map((s) => s.value);
    // 1162 = إزالة الرقم "6" الثاني — القيمة الصحيحة قريبة جداً من ١١٦٢.٥ التي أكّدها المالك
    expect(values).toContain(1162);
  });
  it("يقترح 800 لحالة PR-2027-81P2 (تكلفة 8000 vs بيع 1000)", () => {
    const suggs = suggestCostCorrections(8000, 1000);
    const values = suggs.map((s) => s.value);
    expect(values).toContain(800);
  });
  it("لا يقترح قيمةً أكبر من الحالية", () => {
    const suggs = suggestCostCorrections(1000, 500);
    for (const s of suggs) {
      expect(s.value).toBeLessThan(1000);
    }
  });
  it("يعيد قائمة فارغة على الفارغ", () => {
    expect(suggestCostCorrections("", 500)).toEqual([]);
    expect(suggestCostCorrections(0, 500)).toEqual([]);
  });
  it("يستعمل الوسيط عند غياب البيع", () => {
    const suggs = suggestCostCorrections(10000, null, 200);
    expect(suggs.length).toBeGreaterThan(0);
    // القيمة 100 قريبة من الوسيط 200 ⇒ يجب أن تكون بين المقترحات
    expect(suggs.map((s) => s.value)).toContain(100);
  });
  it("يفرز الأقرب للهدف أوّلاً", () => {
    // retail=1000، هدف=500 ⇒ نقترح: 800 (نقطة قريبة)، 1616.2، 161.62، إلخ
    const suggs = suggestCostCorrections(8000, 1000);
    // أوّل اقتراح يجب أن يكون الأقرب لـ500
    expect(suggs[0].value).toBeCloseTo(800, 0);
  });
});
