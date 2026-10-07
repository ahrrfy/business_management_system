import { describe, expect, it } from "vitest";
import { D, moneyInput, round2 } from "@/lib/money";
import { sanitizeRecipeClipboard } from "../ProductRecipeSection";

// دالة محاكاة لحساب التكاليف المعيارية الحيّة بأمان ضد المُدخلات الجزئية
function calculateRecipeCost(lines: Array<{ qty: string; cost: string }>, labor: string, wastePct: string) {
  let materialsTotal = D(0);
  for (const l of lines) {
    materialsTotal = materialsTotal.plus(moneyInput(l.qty).mul(moneyInput(l.cost)));
  }
  materialsTotal = round2(materialsTotal);

  const rawLabor = moneyInput(labor);
  const laborD = round2(rawLabor.isNegative() ? D(0) : rawLabor);
  const rawWaste = moneyInput(wastePct);
  const wasteD = rawWaste.gt(0) && rawWaste.lt(1) ? rawWaste : D(0);
  const totalBeforeWaste = materialsTotal.plus(laborD);
  const wasteFactor = wasteD.gt(0) && wasteD.lt(1) ? D(1).minus(wasteD) : D(1);
  const totalUnitCost = wasteFactor.gt(0) ? round2(totalBeforeWaste.div(wasteFactor)) : totalBeforeWaste;

  return {
    materialsTotal,
    labor: laborD,
    wastePct: wasteD,
    totalUnitCost,
  };
}

// دالة محاكاة لحساب مؤشرات هامش الربح مع دعم أسعار الجملة والمفرق
function calculateProfitability(
  prices: { sellingPrice?: string | null; wholesalePrice?: string | null },
  selectedTier: "RETAIL" | "WHOLESALE",
  totalUnitCost: ReturnType<typeof D>,
) {
  const hasRetail = Boolean(prices.sellingPrice && moneyInput(prices.sellingPrice).gt(0));
  const hasWholesale = Boolean(prices.wholesalePrice && moneyInput(prices.wholesalePrice).gt(0));

  const effectiveTier =
    (selectedTier === "WHOLESALE" && hasWholesale) || !hasRetail
      ? "WHOLESALE"
      : "RETAIL";

  const rawPrice = effectiveTier === "WHOLESALE" ? prices.wholesalePrice : prices.sellingPrice;
  if (!rawPrice) return null;
  const sellingPrice = moneyInput(rawPrice);
  if (sellingPrice.lte(0)) return null;

  const grossProfit = round2(sellingPrice.minus(totalUnitCost));
  const grossMarginPct = round2(grossProfit.div(sellingPrice).mul(100));
  const isLoss = grossProfit.lt(0);
  const isLowMargin = !isLoss && grossMarginPct.lt(15);

  return {
    priceTier: effectiveTier,
    hasBothTiers: Boolean(hasRetail && hasWholesale),
    sellingPrice,
    grossProfit,
    grossMarginPct,
    isLoss,
    isLowMargin,
  };
}

// دالة محاكاة لتحديد الطاقة الإنتاجية من أرصدة المواد المتوفرة مع استبعاد المواد ذات الكمية الصفرية
function computeCapacity(
  lines: Array<{ variantId: number; qty: string }>,
  stockMap: Record<number, number>,
) {
  if (lines.length === 0) return { maxCapacity: 0, limitingVariantId: null };

  let minCapacity = Number.POSITIVE_INFINITY;
  let limitingVariantId: number | null = null;

  for (const l of lines) {
    const required = Number(moneyInput(l.qty));
    if (required <= 0) continue; // لا يحد الإنتاج إذا كانت الكمية المطلوبة صفراً أو غير موجبة

    const available = stockMap[l.variantId] ?? 0;
    const canMake = Math.floor(Math.max(0, available) / required);

    if (canMake < minCapacity) {
      minCapacity = canMake;
      limitingVariantId = l.variantId;
    }
  }

  const finalCap = Number.isFinite(minCapacity) ? Math.max(0, minCapacity) : 0;
  return { maxCapacity: finalCap, limitingVariantId };
}

describe("وحدة اختبار منطق نسخ ولصق الوصفات والذكاء التشغيلي (BOM Clipboard & Intelligence)", () => {
  it("يحفظ ويسترجع بنود الوصفة في الحافظة بدقة", () => {
    const originalRecipe = {
      recipeName: "وصفة طباعة علم 140x90",
      productName: "علم عراقي ستان مع سارية",
      laborPerOutputBase: "1500.00",
      wasteStdPct: "0.05",
      notes: "طباعة حرارية وجهين",
      lines: [
        {
          inputVariantId: 201,
          inputProductName: "قماش ستان تركي",
          inputSku: "SATIN-TR",
          inputCostPrice: "3500.00",
          qtyPerOutputBase: "1.2000",
          unitName: "متر",
        },
        {
          inputVariantId: 305,
          inputProductName: "سارية ألمنيوم ذهبية",
          inputSku: "POLE-GLD",
          inputCostPrice: "5000.00",
          qtyPerOutputBase: "1.0000",
          unitName: "قطعة",
        },
      ],
      copiedAt: new Date().toISOString(),
    };

    const sanitized = sanitizeRecipeClipboard(originalRecipe);
    expect(sanitized).not.toBeNull();
    expect(sanitized?.recipeName).toBe(originalRecipe.recipeName);
    expect(sanitized?.lines).toHaveLength(2);
    expect(sanitized?.lines[0].inputSku).toBe("SATIN-TR");
    expect(sanitized?.lines[0].qtyPerOutputBase).toBe("1.2000");
    expect(sanitized?.laborPerOutputBase).toBe("1500.00");
    expect(sanitized?.wasteStdPct).toBe("0.05");
  });

  it("يطهر الحافظة بأمان ضد الكائنات التالفة، القيم الصفرية، السلاسل غير الصالحة، وعناصر null", () => {
    // 1. مدخلات فارغة أو غير كائنية
    expect(sanitizeRecipeClipboard(null)).toBeNull();
    expect(sanitizeRecipeClipboard(undefined)).toBeNull();
    expect(sanitizeRecipeClipboard("invalid-string")).toBeNull();
    expect(sanitizeRecipeClipboard(12345)).toBeNull();
    expect(sanitizeRecipeClipboard({})).toBeNull();
    expect(sanitizeRecipeClipboard({ lines: [] })).toBeNull();

    // 2. كائن يحتوي مصفوفة أسطر فاسدة (null, undefined, أرقام سالبة)
    const corruptPayload = {
      recipeName: "وصفة غير مكتملة",
      lines: [
        null,
        undefined,
        "not-an-object",
        { inputVariantId: -5, qtyPerOutputBase: "1" },
        { inputVariantId: 0, qtyPerOutputBase: "1" },
        { inputVariantId: NaN, qtyPerOutputBase: "1" },
        { inputVariantId: 88, qtyPerOutputBase: "2.5", inputProductName: "مادة صالحة" },
      ],
    };

    const res = sanitizeRecipeClipboard(corruptPayload);
    expect(res).not.toBeNull();
    expect(res?.lines).toHaveLength(1);
    expect(res?.lines[0].inputVariantId).toBe(88);
    expect(res?.lines[0].qtyPerOutputBase).toBe("2.5");
    expect(res?.lines[0].inputProductName).toBe("مادة صالحة");
  });

  it("يدعم الترقية والهجرة من الصيغ القديمة للحافظة (Legacy Migration: items, quantity, variantId)", () => {
    const legacyPayload = {
      recipeName: "وصفة قديمة v0",
      items: [
        {
          variantId: 44,
          quantity: "3",
          costPrice: "1200",
          productName: "كرتون مقوى",
          sku: "BOX-01",
        },
      ],
    };

    const migrated = sanitizeRecipeClipboard(legacyPayload);
    expect(migrated).not.toBeNull();
    expect(migrated?.version).toBe(1);
    expect(migrated?.lines).toHaveLength(1);
    expect(migrated?.lines[0].inputVariantId).toBe(44);
    expect(migrated?.lines[0].qtyPerOutputBase).toBe("3");
    expect(migrated?.lines[0].inputCostPrice).toBe("1200");
    expect(migrated?.lines[0].inputProductName).toBe("كرتون مقوى");
  });

  it("يدمج ويزيل تكرار الأصناف المتشابهة في الحافظة لتفادي أخطاء المفاتيح المزدوجة", () => {
    const duplicatePayload = {
      recipeName: "وصفة بأصناف مكررة",
      lines: [
        { inputVariantId: 15, qtyPerOutputBase: "1", inputProductName: "حبر أسود" },
        { inputVariantId: 15, qtyPerOutputBase: "2", inputProductName: "حبر أسود مكرر" },
        { inputVariantId: 20, qtyPerOutputBase: "5", inputProductName: "ورق عادي" },
      ],
    };

    const sanitized = sanitizeRecipeClipboard(duplicatePayload);
    expect(sanitized).not.toBeNull();
    expect(sanitized?.lines).toHaveLength(2);
    expect(sanitized?.lines.map((l) => l.inputVariantId)).toEqual([15, 20]);
    expect(sanitized?.lines[0].qtyPerOutputBase).toBe("3");
  });

  it("يحسب التكلفة المعيارية الحيّة بامتصاص الهدر والعمالة بدقة decimal.js", () => {
    const lines = [
      { qty: "2.0000", cost: "3000.00" }, // 6000
      { qty: "1.0000", cost: "4000.00" }, // 4000 => materialsTotal = 10,000
    ];
    const labor = "2000.00"; // totalBeforeWaste = 12,000
    const wastePct = "0.04"; // 4% waste factor = 0.96 => 12,000 / 0.96 = 12,500

    const res = calculateRecipeCost(lines, labor, wastePct);
    expect(res.materialsTotal.toString()).toBe("10000");
    expect(res.labor.toString()).toBe("2000");
    expect(res.totalUnitCost.toString()).toBe("12500");
  });

  it("يتحمل المُدخلات الجزئية وأخطاء الكتابة المؤقتة مثل النقطة العشرية بدون انهيار الشاشة", () => {
    const partialLines = [
      { qty: ".", cost: "3000.00" },
      { qty: "1.5", cost: "" },
    ];
    const res = calculateRecipeCost(partialLines, ".", ".");
    expect(res.materialsTotal.toString()).toBe("0");
    expect(res.labor.toString()).toBe("0");
    expect(res.totalUnitCost.toString()).toBe("0");
  });

  it("يحمي من نسب الهدر السالبة أو التي تتجاوز أو تساوي 100% ومن العمالة السالبة", () => {
    const lines = [{ qty: "1", cost: "1000" }];

    // هدر 100% أو أكثر (يجب ألا يقسم على صفر أو رقم سالب)
    const res1 = calculateRecipeCost(lines, "500", "1.0");
    expect(res1.totalUnitCost.toString()).toBe("1500");
    expect(res1.wastePct.toString()).toBe("0");

    const resOver = calculateRecipeCost(lines, "500", "1.5");
    expect(resOver.totalUnitCost.toString()).toBe("1500");

    // هدر سالب
    const resNegative = calculateRecipeCost(lines, "500", "-0.1");
    expect(resNegative.totalUnitCost.toString()).toBe("1500");
    expect(resNegative.wastePct.toString()).toBe("0");

    // عمالة سالبة (يجب ألا تخفض تكلفة المواد)
    const resNegLabor = calculateRecipeCost(lines, "-500", "0");
    expect(resNegLabor.labor.toString()).toBe("0");
    expect(resNegLabor.totalUnitCost.toString()).toBe("1000");
  });

  it("يحسب هامش الربح المتوقع ويدعم التبديل بين أسعار الجملة والمفرق والرجوع التلقائي للجملة", () => {
    const cost = D("12500");

    // حالة 1: سعر بيع رابح بهامش سليم (20,000 د.ع)
    const healthyProfit = calculateProfitability({ sellingPrice: "20000" }, "RETAIL", cost);
    expect(healthyProfit).not.toBeNull();
    expect(healthyProfit?.grossProfit.toString()).toBe("7500");
    expect(healthyProfit?.grossMarginPct.toString()).toBe("37.5"); // 7500 / 20000 = 37.5%
    expect(healthyProfit?.isLoss).toBe(false);
    expect(healthyProfit?.isLowMargin).toBe(false);

    // حالة 2: منتج بسعر جملة فقط (15,000 د.ع) دون سعر مفرق
    const wholesaleOnly = calculateProfitability({ wholesalePrice: "15000" }, "RETAIL", cost);
    expect(wholesaleOnly?.priceTier).toBe("WHOLESALE");
    expect(wholesaleOnly?.grossProfit.toString()).toBe("2500"); // 15000 - 12500 = 2500
    expect(wholesaleOnly?.grossMarginPct.toString()).toBe("16.67");

    // حالة 3: منتج له كِلا السعرين ويتم التبديل بينهما
    const prices = { sellingPrice: "25000", wholesalePrice: "18000" };
    const retailMode = calculateProfitability(prices, "RETAIL", cost);
    const wholesaleMode = calculateProfitability(prices, "WHOLESALE", cost);
    expect(retailMode?.priceTier).toBe("RETAIL");
    expect(retailMode?.hasBothTiers).toBe(true);
    expect(wholesaleMode?.priceTier).toBe("WHOLESALE");
    expect(wholesaleMode?.grossProfit.toString()).toBe("5500"); // 18000 - 12500 = 5500

    // حالة 4: خسارة تشغيلية (سعر البيع 10,000 د.ع < التكلفة 12,500 د.ع)
    const lossCase = calculateProfitability({ sellingPrice: "10000" }, "RETAIL", cost);
    expect(lossCase?.isLoss).toBe(true);
    expect(lossCase?.grossProfit.toString()).toBe("-2500");
    expect(lossCase?.grossMarginPct.toString()).toBe("-25");
  });

  it("يحسب الطاقة الإنتاجية الفورية ويكتشف المادة الحادة (Bottleneck)", () => {
    const lines = [
      { variantId: 10, qty: "2" }, // تحتاج 2
      { variantId: 20, qty: "1" }, // تحتاج 1
    ];

    // رصيد 10 = 100 وحدة (يكفي 50)
    // رصيد 20 = 15 وحدة (يكفي 15 فقط)
    const stock = { 10: 100, 20: 15 };
    const cap = computeCapacity(lines, stock);

    expect(cap.maxCapacity).toBe(15);
    expect(cap.limitingVariantId).toBe(20);

    // عند نفاذ مادة خام بالكامل
    const emptyStock = { 10: 100, 20: 0 };
    const emptyCap = computeCapacity(lines, emptyStock);
    expect(emptyCap.maxCapacity).toBe(0);
    expect(emptyCap.limitingVariantId).toBe(20);

    // عند غياب سجل المخزون تماماً (undefined في المخزن)
    const missingStock = { 10: 100 };
    const missingCap = computeCapacity(lines, missingStock);
    expect(missingCap.maxCapacity).toBe(0);
    expect(missingCap.limitingVariantId).toBe(20);
  });

  it("يتعامل بكفاءة مع وصفات ضخمة (100+ مادة خام) أو وصفات خالية (0 مواد)", () => {
    // 1. وصفة خالية
    const emptyCap = computeCapacity([], {});
    expect(emptyCap.maxCapacity).toBe(0);
    expect(emptyCap.limitingVariantId).toBeNull();

    // 2. وصفة ضخمة بـ 120 مادة خام
    const bigLines: Array<{ variantId: number; qty: string }> = [];
    const bigStock: Record<number, number> = {};
    for (let i = 1; i <= 120; i++) {
      bigLines.push({ variantId: i, qty: "1" });
      bigStock[i] = 50 + i;
    }
    bigStock[42] = 12; // المادة 42 هي عنق الزجاجة بـ 12 وحدة

    const bigCap = computeCapacity(bigLines, bigStock);
    expect(bigCap.maxCapacity).toBe(12);
    expect(bigCap.limitingVariantId).toBe(42);

    // حساب التكلفة لوصفة ضخمة
    const bigCostLines = bigLines.map((l) => ({ qty: l.qty, cost: "100" }));
    const costRes = calculateRecipeCost(bigCostLines, "5000", "0.05");
    expect(costRes.materialsTotal.toString()).toBe("12000"); // 120 * 100 = 12,000
    expect(costRes.labor.toString()).toBe("5000"); // 17,000 / 0.95 = 17,894.74
    expect(costRes.totalUnitCost.toString()).toBe("17894.74");
  });

  it("يستبعد المنتج الحالي من المواد المنسوخة لتفادي إضافة المنتج كمكوّن لنفسه", () => {
    const currentPrimaryVariantId = 55;
    const copiedLines = [
      { inputVariantId: 10, inputProductName: "حبر أسود", qtyPerOutputBase: "1" },
      { inputVariantId: 55, inputProductName: "المنتج نفسه", qtyPerOutputBase: "1" }, // يجب استبعاده
      { inputVariantId: 20, inputProductName: "ورق مقوى", qtyPerOutputBase: "5" },
    ];

    const safeLines = copiedLines.filter((l) => l.inputVariantId !== currentPrimaryVariantId);
    expect(safeLines).toHaveLength(2);
    expect(safeLines.map((l) => l.inputVariantId)).toEqual([10, 20]);
  });

  it("يحدد النص الفرعي لبطاقة الطاقة الإنتاجية (ATP) بدقة أثناء التحميل وبعد اكتمال الفحص", () => {
    function resolveAtpSubtitle(
      activeLinesCount: number,
      stockData: { maxCapacity: number; limitingComponent: string | null } | undefined,
      currentBranchId?: number,
    ): string {
      if (activeLinesCount === 0) return "أضف مواداً أولية للوصفة";
      if (!stockData) {
        return currentBranchId ? "فحص أرصدة المستودع..." : "اختر فرعاً لمعاينة الرصيد";
      }
      if (stockData.limitingComponent) return `العائق: ${stockData.limitingComponent}`;
      if (stockData.maxCapacity > 0) return "المواد متوفرة بالكامل";
      return "لا يوجد رصيد كافٍ";
    }

    // 1. لا توجد مواد في الوصفة
    expect(resolveAtpSubtitle(0, undefined, 1)).toBe("أضف مواداً أولية للوصفة");

    // 2. جارٍ الفحص بفرع محدد (يجب ألا يعرض "لا يوجد رصيد كافٍ" قبل اكتمال الفحص)
    expect(resolveAtpSubtitle(3, undefined, 1)).toBe("فحص أرصدة المستودع...");

    // 3. جارٍ الفحص وبلا فرع محدد
    expect(resolveAtpSubtitle(3, undefined, undefined)).toBe("اختر فرعاً لمعاينة الرصيد");

    // 4. اكتمل الفحص وتوجد مادة عائقة
    expect(
      resolveAtpSubtitle(3, { maxCapacity: 10, limitingComponent: "حبر أسود" }, 1),
    ).toBe("العائق: حبر أسود");

    // 5. اكتمل الفحص والمواد متوفرة بالكامل
    expect(
      resolveAtpSubtitle(3, { maxCapacity: 50, limitingComponent: null }, 1),
    ).toBe("المواد متوفرة بالكامل");

    // 6. اكتمل الفحص والرصيد صفر وبلا مادة عائقة مسماة
    expect(
      resolveAtpSubtitle(3, { maxCapacity: 0, limitingComponent: null }, 1),
    ).toBe("لا يوجد رصيد كافٍ");
  });

  it("يولّد مفاتيح React فريدة لكل سطر مادة لمنع تحذيرات وتعارض المفاتيح المزدوجة", () => {
    const rawLines = [
      { inputVariantId: 44, name: "ورق" },
      { inputVariantId: 44, name: "ورق معدل" },
    ];
    const keys = rawLines.map((l, idx) => `${l.inputVariantId}-${idx}`);
    expect(keys).toEqual(["44-0", "44-1"]);
    expect(new Set(keys).size).toBe(2);
  });
});
