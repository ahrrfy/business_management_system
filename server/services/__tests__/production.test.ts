// اختبارات وحدة الإنتاج/التحويل: امتصاص الكلفة، WAVG على المخرَج، الذرّية،
// «لا قيد محاسبي»، الإلغاء، idempotency، حارس التحويل الذاتي، والوصفات (تحجيم/معاينة).
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, sumMoney } from "../money";
import { cancelProduction, computeRunCosts, createProduction, getProduction, runPreview, spoilageSplit } from "../productionService";
import { createRecipe, getRecipe, recipePreview } from "../recipeService";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

const TABLES = [
  "accountingEntries", "expenseStockItems", "expenses", "receipts",
  "productionLines", "productionOrders", "productionRecipeLines", "productionRecipes",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "branches", "users", "idempotencyKeys",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES", isActive: true },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values([
    { id: 1, name: "ورق" }, { id: 2, name: "دفتر أ" }, { id: 3, name: "دفتر ب" },
    { id: 4, name: "منتج ج" }, { id: 5, name: "منتج له رصيد" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAPER", costPrice: "1.00" },   // مدخل: ورقة بكلفة 1
    { id: 2, productId: 2, sku: "BOOK-A", costPrice: "0.00" },  // مخرجات (تبدأ بلا كلفة)
    { id: 3, productId: 3, sku: "BOOK-B", costPrice: "0.00" },
    { id: 4, productId: 4, sku: "PROD-C", costPrice: "0.00" },
    { id: 5, productId: 5, sku: "PROD-D", costPrice: "10.00" }, // مخرَج له رصيد قائم لاختبار WAVG
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "ربطة", conversionFactor: "500" },
    { id: 3, variantId: 2, unitName: "دفتر", conversionFactor: "1", isBaseUnit: true },
  ]);
  // مخزون: ورق وافر بالفرع 1 + رصيد قائم للصنف 5 (10 وحدات @ كلفة 10).
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100000 },
    { variantId: 5, branchId: 1, quantity: 10 },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

async function cost(variantId: number): Promise<string> {
  const r = (await db().select({ c: s.productVariants.costPrice }).from(s.productVariants).where(eq(s.productVariants.id, variantId)))[0];
  return String(r?.c);
}
async function stock(variantId: number, branchId = 1): Promise<number> {
  const r = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock)
    .where(sql`${s.branchStock.variantId} = ${variantId} AND ${s.branchStock.branchId} = ${branchId}`))[0];
  return Number(r?.q ?? 0);
}
async function outputLines(orderId: number) {
  const lines = await db().select().from(s.productionLines).where(eq(s.productionLines.productionOrderId, orderId));
  return lines.filter((l: any) => l.direction === "OUTPUT");
}
async function entries() {
  return db().select().from(s.accountingEntries);
}

describe("الإنتاج: امتصاص الكلفة", () => {
  it("Σ allocatedCost == totalCost ومتساوي على المخرجات", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 100 }],     // 100 ورقة @ 1 = 100
      outputs: [{ variantId: 2, baseQuantity: 3 }, { variantId: 3, baseQuantity: 3 }, { variantId: 4, baseQuantity: 4 }],
    }, actor);
    expect(r.totalCost).toBe("100.00");
    const outs = await outputLines(r.productionOrderId);
    // المجموع على decimal أصيل: المُخصَّص الكلي = ١٠٠.٠٠ بالضبط (مطابقة كاملة لكلفة المُدخَل).
    expect(sumMoney(outs.map((l: any) => l.allocatedCost)).eq(money("100"))).toBe(true);
    expect(await cost(2)).toBe("10.00");
    expect(await cost(3)).toBe("10.00");
    expect(await cost(4)).toBe("10.00");
    expect(await stock(1)).toBe(100000 - 100);
    expect(await stock(2)).toBe(3);
  });

  it("بقايا التقريب: آخر سطر يمتصّ ⇒ المجموع 100.00 بالضبط", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 100 }],
      outputs: [{ variantId: 2, baseQuantity: 1 }, { variantId: 3, baseQuantity: 1 }, { variantId: 4, baseQuantity: 1 }],
    }, actor);
    const outs = await outputLines(r.productionOrderId);
    const allocs = outs.map((l: any) => l.allocatedCost).sort();
    // 33.33 / 33.33 / 33.34
    // المجموع على decimal أصيل: 33.33 + 33.33 + 33.34 = 100.00 بالضبط (HALF_UP يضمن الانطباق).
    expect(sumMoney(outs.map((l: any) => l.allocatedCost)).eq(money("100"))).toBe(true);
    expect(allocs).toContain("33.34");
  });

  it("العمالة تدخل totalCost وتُمتصّ في كلفة المخرَج", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 50 }], // 50 مواد
      laborCost: "20",                               // + 20 عمالة = 70
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, actor);
    expect(r.totalCost).toBe("70.00");
    expect(await cost(2)).toBe("7.00"); // 70 / 10
  });

  it("WAVG على المخرَج ذي الرصيد القائم", async () => {
    // الصنف 5: رصيد 10 @ كلفة 10 (قيمة 100). ننتج 10 منه بكلفة مواد 50 (5/وحدة).
    await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 50 }], // 50 @ 1 = 50 ⇒ 5/وحدة على 10 مخرجات
      outputs: [{ variantId: 5, baseQuantity: 10 }],
    }, actor);
    // (10*10 + 10*5) / 20 = 7.50
    expect(await cost(5)).toBe("7.50");
    expect(await stock(5)).toBe(20);
  });
});

describe("الإنتاج: الذرّية والقيد المحاسبي", () => {
  it("نقص مدخل ⇒ ROLLBACK كامل (لا مستند/حركة/خصم)", async () => {
    await expect(createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 100001 }], // أكثر من المتاح
      outputs: [{ variantId: 2, baseQuantity: 1 }],
    }, actor)).rejects.toThrow();
    const orders = await db().select().from(s.productionOrders);
    expect(orders).toHaveLength(0);
    expect(await stock(1)).toBe(100000); // لم يُخصم
    const moves = await db().select().from(s.inventoryMovements);
    expect(moves).toHaveLength(0);
  });

  it("الإنتاج لا يكتب أي قيد محاسبي (تحويل أصل↔أصل)", async () => {
    await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 100 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, actor);
    const entries = await db().select().from(s.accountingEntries);
    expect(entries).toHaveLength(0);
  });
});

describe("الإنتاج: الإلغاء", () => {
  it("الإلغاء يعكس المخزون ويضع الحالة CANCELLED", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 500 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, actor);
    expect(await stock(1)).toBe(100000 - 500);
    expect(await stock(2)).toBe(10);
    await cancelProduction(r.productionOrderId, { ...actor, role: "admin" });
    expect(await stock(1)).toBe(100000); // الورق عاد
    expect(await stock(2)).toBe(0);      // الدفتر سُحب
    const po = (await db().select().from(s.productionOrders).where(eq(s.productionOrders.id, r.productionOrderId)))[0];
    expect(po.status).toBe("CANCELLED");
  });

  it("الإلغاء محظور إن استُهلك المخرَج (CONFLICT)", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 500 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, actor);
    // محاكاة بيع: صفّر رصيد المخرَج.
    await db().update(s.branchStock).set({ quantity: 0 })
      .where(sql`${s.branchStock.variantId} = 2 AND ${s.branchStock.branchId} = 1`);
    await expect(cancelProduction(r.productionOrderId, { ...actor, role: "admin" })).rejects.toThrow();
  });

  it("عزل الفرع: غير المدير من فرع آخر يُمنع من الإلغاء", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 100 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, actor);
    await expect(cancelProduction(r.productionOrderId, { userId: 1, branchId: 2, role: "cashier" })).rejects.toThrow(/فرع/);
  });
});

describe("الإنتاج: idempotency وحارس التحويل الذاتي", () => {
  it("نفس clientRequestId ⇒ مستند واحد", async () => {
    const key = "req-prod-1";
    const a = await createProduction({ branchId: 1, inputs: [{ variantId: 1, baseQuantity: 100 }], outputs: [{ variantId: 2, baseQuantity: 10 }], clientRequestId: key }, actor);
    const b = await createProduction({ branchId: 1, inputs: [{ variantId: 1, baseQuantity: 100 }], outputs: [{ variantId: 2, baseQuantity: 10 }], clientRequestId: key }, actor);
    expect(b.productionOrderId).toBe(a.productionOrderId);
    expect((b as any).idempotent).toBe(true);
    const orders = await db().select().from(s.productionOrders);
    expect(orders).toHaveLength(1);
  });

  it("صنف مدخل ومخرج معاً ⇒ يُرفض", async () => {
    await expect(createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 100 }],
      outputs: [{ variantId: 1, baseQuantity: 100 }],
    }, actor)).rejects.toThrow();
  });

  it("تحويل بوحدة (ربطة) يخصم الأوراق الأساس", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, productUnitId: 2, quantity: "1" }], // ربطة = 500 ورقة
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, actor);
    expect(r.totalCost).toBe("500.00"); // 500 @ 1
    expect(await stock(1)).toBe(100000 - 500);
  });
});

describe("الإنتاج: الوصفات", () => {
  it("recipePreview يحجّم المدخلات ويحسب الكلفة، و createProduction يخزّن linkedRecipeId", async () => {
    const rec = await createRecipe({
      name: "ملزمة منهج X",
      outputVariantId: 2,
      outputProductUnitId: 3, // دفتر (base)
      lines: [{ inputVariantId: 1, qtyPerOutputBase: "30" }], // 30 ورقة لكل ملزمة
    }, actor);
    const pv = await recipePreview({ recipeId: rec.recipeId, outputQuantity: "50", branchId: 1 });
    expect(pv.outputBase).toBe(50);
    expect(pv.inputs[0].baseQuantity).toBe(1500); // 30 × 50
    expect(pv.materialsCost).toBe("1500.00");
    expect(pv.inputs[0].available).toBe(100000);

    const prod = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: pv.inputs[0].baseQuantity }],
      outputs: [{ variantId: pv.outputVariantId, baseQuantity: pv.outputBase }],
      linkedRecipeId: rec.recipeId,
    }, actor);
    const po = (await db().select().from(s.productionOrders).where(eq(s.productionOrders.id, prod.productionOrderId)))[0];
    expect(Number(po.linkedRecipeId)).toBe(rec.recipeId);
    expect(await stock(1)).toBe(100000 - 1500);
    expect(await stock(2)).toBe(50);
  });

  it("تحجيم لا يُنتج عدداً صحيحاً ⇒ يُرفض", async () => {
    const rec = await createRecipe({
      name: "وصفة كسرية",
      outputVariantId: 2,
      outputProductUnitId: 3,
      lines: [{ inputVariantId: 1, qtyPerOutputBase: "0.5" }],
    }, actor);
    await expect(recipePreview({ recipeId: rec.recipeId, outputQuantity: "3", branchId: 1 })).rejects.toThrow();
  });

  it("المنتج الناتج لا يكون مكوّناً من نفسه", async () => {
    await expect(createRecipe({
      name: "وصفة ذاتية",
      outputVariantId: 2,
      outputProductUnitId: 3,
      lines: [{ inputVariantId: 2, qtyPerOutputBase: "1" }],
    }, actor)).rejects.toThrow();
  });
});

// ───────────────────── محرّك الدفعة/الهدر (التحديث: شاشتا الإنتاج/الوصفات) ─────────────────────
describe("الإنتاج: محرّك computeRunCosts/spoilageSplit (نقي)", () => {
  const D = (n: number | string) => new Decimal(n);
  const paperLine = [{ unitCost: D(1), qtyPerOutputBase: D(30) }]; // 30 ورقة @ 1 لكل وحدة ناتج

  it("الدفعة تقود الاستهلاك: التالف لا يضاعف استهلاك المواد", () => {
    const a = computeRunCosts({ recipeLines: paperLine, laborPerUnit: D(0), wasteStdPct: D("0.05"), batch: 100, scrap: 0 });
    const b = computeRunCosts({ recipeLines: paperLine, laborPerUnit: D(0), wasteStdPct: D("0.05"), batch: 100, scrap: 50 });
    expect(a.materialsCost.toFixed(2)).toBe("3000.00");
    expect(b.materialsCost.toFixed(2)).toBe("3000.00"); // ثابت مهما تغيّر التالف
  });

  it("تفريق الهدر: batch 100 / تالف 12 / معياري 5% ⇒ غير طبيعي 7، خسارة 210، سليم 88، وحدة 31.70", () => {
    const r = computeRunCosts({ recipeLines: paperLine, laborPerUnit: D(0), wasteStdPct: D("0.05"), batch: 100, scrap: 12 });
    expect(r.normalAllow).toBe(5);
    expect(r.abnormalUnits).toBe(7);
    expect(r.good).toBe(88);
    expect(r.abnormalLoss.toFixed(2)).toBe("210.00");
    expect(r.absorbedCost.toFixed(2)).toBe("2790.00");
    expect(r.unitCost.toFixed(2)).toBe("31.70"); // 2790/88
  });

  it("حفظ القيمة: absorbed + abnormalLoss == totalCost دائماً (بعمالة)", () => {
    for (const scrap of [0, 3, 5, 12, 40]) {
      const r = computeRunCosts({ recipeLines: paperLine, laborPerUnit: D(2), wasteStdPct: D("0.05"), batch: 100, scrap });
      expect(r.absorbedCost.plus(r.abnormalLoss).toFixed(2)).toBe(r.totalCost.toFixed(2));
    }
  });

  it("تالف ≤ المعياري ⇒ لا هدر غير طبيعي وكل الكلفة تُمتَص", () => {
    const r = computeRunCosts({ recipeLines: paperLine, laborPerUnit: D(0), wasteStdPct: D("0.05"), batch: 100, scrap: 5 });
    expect(r.abnormalUnits).toBe(0);
    expect(r.abnormalLoss.toFixed(2)).toBe("0.00");
    expect(r.absorbedCost.toFixed(2)).toBe("3000.00");
  });

  it("spoilageSplit مباشرةً: 100/20/5% ⇒ غير طبيعي 15، خسارة 150، مُمتَصّ 850", () => {
    const sp = spoilageSplit(D(1000), 100, 20, D("0.05"));
    expect(sp.abnormalUnits).toBe(15);
    expect(sp.abnormalLoss.toFixed(2)).toBe("150.00");
    expect(sp.absorbedCost.toFixed(2)).toBe("850.00");
    expect(sp.good).toBe(80);
  });
});

describe("الإنتاج: مسار التشغيل بوصفة (run) + قيد الهدر", () => {
  async function mkRecipe(waste = "0.05", labor = "0") {
    return createRecipe({
      name: "ملزمة هدر", outputVariantId: 2, outputProductUnitId: 3,
      laborPerOutputBase: labor, wasteStdPct: waste,
      lines: [{ inputVariantId: 1, qtyPerOutputBase: "30" }],
    }, actor);
  }

  it("الاستهلاك = perOutputBase × الدفعة (لا السليم)، السليم يُضاف، كلفة الوحدة = المُمتَصّ/السليم", async () => {
    const rec = await mkRecipe();
    const r = await createProduction({ branchId: 1, run: { recipeId: rec.recipeId, batchQty: 100, scrapQty: 12 } }, actor);
    expect(await stock(1)).toBe(100000 - 3000); // 30×100 (دفعة) لا 30×88
    expect(await stock(2)).toBe(88);            // السليم فقط
    expect(await cost(2)).toBe("31.70");
    const po = (await db().select().from(s.productionOrders).where(eq(s.productionOrders.id, r.productionOrderId)))[0];
    expect(Number(po.batchQty)).toBe(100);
    expect(Number(po.goodQty)).toBe(88);
    expect(Number(po.scrapQty)).toBe(12);
    expect(po.abnormalLoss).toBe("210.00");
    expect(po.wasteStdPct).toBe("0.05"); // لقطة الهدر المعياري وقت التشغيل (للمستند الثابت)

    // getProduction يشتقّ الإنتاجية خادمياً (مصدر حقيقة واحد — لا اشتقاق في العميل).
    const doc: any = await getProduction(r.productionOrderId, { ...actor, role: "admin" });
    expect(doc.normalAllow).toBe(5);
    expect(doc.abnormalUnits).toBe(7);
    expect(doc.yieldPct).toBeCloseTo(0.88, 4);
  });

  it("الهدر غير الطبيعي ⇒ قيد WASTAGE بالكلفة بلا إيصال (لا يمسّ الصندوق)", async () => {
    const rec = await mkRecipe();
    await createProduction({ branchId: 1, run: { recipeId: rec.recipeId, batchQty: 100, scrapQty: 12 } }, actor);
    const es = await entries();
    expect(es).toHaveLength(1);
    expect(es[0].entryType).toBe("WASTAGE");
    expect(es[0].cost).toBe("210.00");
    expect(es[0].amount).toBe("210.00");
    expect(es[0].receiptId).toBeNull();
  });

  it("تالف ضمن المعيار ⇒ لا قيد WASTAGE وكل الكلفة في كلفة السليم", async () => {
    const rec = await mkRecipe();
    await createProduction({ branchId: 1, run: { recipeId: rec.recipeId, batchQty: 100, scrapQty: 4 } }, actor); // normalAllow 5
    expect(await entries()).toHaveLength(0);
    expect(await cost(2)).toBe("31.25"); // 3000/96
  });

  it("نقص مخزون مدخل ⇒ ROLLBACK كامل (لا مستند/قيد/خصم)", async () => {
    const rec = await mkRecipe();
    await expect(createProduction({ branchId: 1, run: { recipeId: rec.recipeId, batchQty: 100000, scrapQty: 0 } }, actor)).rejects.toThrow();
    expect(await db().select().from(s.productionOrders)).toHaveLength(0);
    expect(await stock(1)).toBe(100000);
    expect(await entries()).toHaveLength(0);
  });

  it("الإلغاء يعكس المخزون ويعكس قيد WASTAGE (صافي القيود صفر)", async () => {
    const rec = await mkRecipe();
    const r = await createProduction({ branchId: 1, run: { recipeId: rec.recipeId, batchQty: 100, scrapQty: 12 } }, actor);
    await cancelProduction(r.productionOrderId, { ...actor, role: "admin" });
    expect(await stock(1)).toBe(100000); // الورق عاد
    expect(await stock(2)).toBe(0);      // السليم سُحب
    const es = await entries();
    expect(es).toHaveLength(2); // قيد + عكسه
    // قيد + عكسه ⇒ صفر بالضبط (مطلب محاسبي صارم لا «قريباً منه»).
    expect(sumMoney(es.map((e: any) => e.amount)).isZero()).toBe(true);
  });

  it("السليم ≤ 0 (التالف = الدفعة) ⇒ يُرفض", async () => {
    const rec = await mkRecipe();
    await expect(createProduction({ branchId: 1, run: { recipeId: rec.recipeId, batchQty: 10, scrapQty: 10 } }, actor)).rejects.toThrow();
  });
});

describe("الإنتاج: runPreview = الترحيل بالضبط", () => {
  it("المعاينة تطابق createProduction (مواد/هدر/كلفة الوحدة/WAVG)", async () => {
    const rec = await createRecipe({
      name: "ملزمة معاينة", outputVariantId: 2, outputProductUnitId: 3, wasteStdPct: "0.05",
      lines: [{ inputVariantId: 1, qtyPerOutputBase: "30" }],
    }, actor);
    const pv = await runPreview({ recipeId: rec.recipeId, batchQty: 100, scrapQty: 12, branchId: 1 });
    expect(pv.materialsCost).toBe("3000.00");
    expect(pv.abnormalLoss).toBe("210.00");
    expect(pv.unitCost).toBe("31.70");
    expect(pv.good).toBe(88);
    expect(pv.inputs[0].consumed).toBe(3000);
    expect(pv.inputs[0].available).toBe(100000);
    expect(pv.anyShort).toBe(false);
    expect(pv.wavg.newCost).toBe("31.70");

    await createProduction({ branchId: 1, run: { recipeId: rec.recipeId, batchQty: 100, scrapQty: 12 } }, actor);
    expect(await cost(2)).toBe(pv.wavg.newCost); // المعاينة = الفعلي
  });

  it("الوصفة تخزّن وتعيد wasteStdPct ووحدات المكوّنات للتعديل", async () => {
    const rec = await createRecipe({
      name: "وصفة بهدر", outputVariantId: 2, outputProductUnitId: 3, wasteStdPct: "0.08",
      lines: [{ inputVariantId: 1, inputProductUnitId: 2, qtyPerOutputBase: "500" }],
    }, actor);
    const g: any = await getRecipe(rec.recipeId);
    expect(g.wasteStdPct).toBe("0.08");
    expect(g.lines[0].units.length).toBeGreaterThan(0);
  });
});
