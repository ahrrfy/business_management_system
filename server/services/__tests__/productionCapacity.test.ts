// اختبارات `recipeCapacity` — السقفُ الذي تعرضه شاشة التشغيل وتزرعه بضغطة.
// كلُّ حالةٍ هنا تحرس ملاحظةً أمسكتها مراجعة Codex على #911 أو الثابتَ الذي جاء المسار له.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { recipeCapacity } from "../productionService";
import { createRecipe } from "../recipeService";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

const TABLES = [
  "productionLines", "productionOrders", "productionRecipeLines", "productionRecipes",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "branches", "users",
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
    { id: 1, name: "ورق" }, { id: 2, name: "دفتر" }, { id: 3, name: "غراء" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAPER", costPrice: "1.00" },
    { id: 2, productId: 2, sku: "BOOK", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "GLUE", costPrice: "2.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "دفتر", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "علبة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 1000 },  // ورق في الفرع 1
    { variantId: 3, branchId: 1, quantity: 100 },   // غراء في الفرع 1
    { variantId: 1, branchId: 2, quantity: 7 },     // رصيدٌ مختلف تماماً في الفرع 2
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

/** وصفة: مخرَجها الصنف 2، وأسطرُها كما تُمرَّر. */
async function makeRecipe(lines: Array<{ inputVariantId: number; qtyPerOutputBase: string }>, name = "وصفة") {
  return createRecipe(
    { name, outputVariantId: 2, outputProductUnitId: 2, laborPerOutputBase: "0", wasteStdPct: "0", lines },
    actor,
  );
}

describe("recipeCapacity — سقف الإنتاج الممكن", () => {
  it("السقف = أقلّ (المتاح ÷ المعامل)، والمكوّن الحادّ يُسمّى", async () => {
    // ورق 1000 بمعامل 10 ⇒ 100 دفتر · غراء 100 بمعامل 4 ⇒ 25 دفتراً (هو الحادّ).
    const r = await makeRecipe([
      { inputVariantId: 1, qtyPerOutputBase: "10" },
      { inputVariantId: 3, qtyPerOutputBase: "4" },
    ]);
    const cap = await recipeCapacity({ recipeId: r.recipeId, branchId: 1 });
    expect(cap.maxByStock).toBe(25);
    expect(cap.maxBatch).toBe(25);       // بلا معامل كسريّ ⇒ لا قصّ
    expect(cap.batchMultiple).toBe(1);
    expect(cap.limitingComponent).toBe("غراء");
    expect(cap.isActive).toBe(true);
  });

  it("⭐ P2: المتغيّر المكرَّر على سطرين يُجمَع قبل القسمة", async () => {
    // سطران من الورق بمعامل 10 لكلٍّ ⇒ الاستهلاك الحقيقيّ 20/دفتر ⇒ 1000÷20 = 50 لا 100.
    const r = await makeRecipe([
      { inputVariantId: 1, qtyPerOutputBase: "10" },
      { inputVariantId: 1, qtyPerOutputBase: "10" },
    ]);
    const cap = await recipeCapacity({ recipeId: r.recipeId, branchId: 1 });
    expect(cap.maxByStock).toBe(50);
    expect(cap.components).toHaveLength(1);          // صفٌّ واحد للمتغيّر لا صفّان
    expect(cap.components[0].perOutputBase).toBe("20");
  });

  it("⭐ المعامل الكسريّ يقصّ السقف على المضاعف — وهو بلاغ المالك بعينه", async () => {
    // ورق 1000 ÷ 10 = 100، لكنّ الغراء بمعامل 0.01 يفرض مضاعفات 100.
    const r = await makeRecipe([
      { inputVariantId: 1, qtyPerOutputBase: "10" },
      { inputVariantId: 3, qtyPerOutputBase: "0.01" },
    ]);
    const cap = await recipeCapacity({ recipeId: r.recipeId, branchId: 1 });
    expect(cap.batchMultiple).toBe(100);
    expect(cap.maxByStock).toBe(100);
    expect(cap.maxBatch).toBe(100);
    expect(cap.batchMultipleNote).toContain("مضاعفةً لـ100");
  });

  it("سقفٌ دون أصغر دفعةٍ صالحة ⇒ صفر صريح لا رقمٌ يُرفَض عند الترحيل", async () => {
    // ورق بمعامل 200 ⇒ الكفاية تسمح بـ5 فقط، والمضاعف 100 ⇒ لا دفعة صالحة.
    const r = await makeRecipe([
      { inputVariantId: 1, qtyPerOutputBase: "200" },
      { inputVariantId: 3, qtyPerOutputBase: "0.01" },
    ]);
    const cap = await recipeCapacity({ recipeId: r.recipeId, branchId: 1 });
    expect(cap.maxByStock).toBe(5);
    expect(cap.maxBatch).toBe(0);
  });

  it("عزل الفرع: نفس الوصفة تُعطي سقفاً مختلفاً لكل فرع", async () => {
    const r = await makeRecipe([{ inputVariantId: 1, qtyPerOutputBase: "1" }]);
    expect((await recipeCapacity({ recipeId: r.recipeId, branchId: 1 })).maxByStock).toBe(1000);
    expect((await recipeCapacity({ recipeId: r.recipeId, branchId: 2 })).maxByStock).toBe(7);
  });

  it("مكوّنٌ بلا صفّ مخزونٍ في الفرع = صفر لا «غير معلوم»", async () => {
    // الغراء غير موجود في الفرع 2 إطلاقاً.
    const r = await makeRecipe([
      { inputVariantId: 1, qtyPerOutputBase: "1" },
      { inputVariantId: 3, qtyPerOutputBase: "1" },
    ]);
    const cap = await recipeCapacity({ recipeId: r.recipeId, branchId: 2 });
    expect(cap.maxBatch).toBe(0);
    expect(cap.limitingComponent).toBe("غراء");
  });

  it("الوصفة المعطّلة تُعلَن معطّلةً — الشاشة تكتم السقف عندها", async () => {
    const r = await makeRecipe([{ inputVariantId: 1, qtyPerOutputBase: "1" }]);
    await db().update(s.productionRecipes).set({ isActive: false }).where(sql`id = ${r.recipeId}`);
    const cap = await recipeCapacity({ recipeId: r.recipeId, branchId: 1 });
    expect(cap.isActive).toBe(false);
  });

  it("وصفةٌ غير موجودة تُرفَض صراحةً", async () => {
    await expect(recipeCapacity({ recipeId: 9999, branchId: 1 })).rejects.toThrow();
  });
});
