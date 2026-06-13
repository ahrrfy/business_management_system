// اختبارات وحدة الإنتاج/التحويل: امتصاص الكلفة، WAVG على المخرَج، الذرّية،
// «لا قيد محاسبي»، الإلغاء، idempotency، حارس التحويل الذاتي، والوصفات (تحجيم/معاينة).
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelProduction, createProduction } from "../productionService";
import { createRecipe, recipePreview } from "../recipeService";

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

describe("الإنتاج: امتصاص الكلفة", () => {
  it("Σ allocatedCost == totalCost ومتساوي على المخرجات", async () => {
    const r = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 100 }],     // 100 ورقة @ 1 = 100
      outputs: [{ variantId: 2, baseQuantity: 3 }, { variantId: 3, baseQuantity: 3 }, { variantId: 4, baseQuantity: 4 }],
    }, actor);
    expect(r.totalCost).toBe("100.00");
    const outs = await outputLines(r.productionOrderId);
    const sumAlloc = outs.reduce((a: number, l: any) => a + Number(l.allocatedCost), 0);
    expect(sumAlloc).toBeCloseTo(100, 2);
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
    const sum = outs.reduce((a: number, l: any) => a + Number(l.allocatedCost), 0);
    expect(sum).toBeCloseTo(100, 2);
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
