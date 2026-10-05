import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money } from "../money";
import {
  analyzeBundleRequirements,
  produceBundleComponents,
} from "../productionService";
import { createRecipe } from "../recipeService";

const actor = { userId: 1, branchId: 1 };
function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const TABLES = [
  "accountingEntries",
  "expenseStockItems",
  "expenses",
  "receipts",
  "productionLines",
  "productionOrders",
  "productionRecipeLines",
  "productionRecipes",
  "inventoryMovements",
  "onlineOrderItems",
  "onlineOrders",
  "reservationStock",
  "branchStock",
  "productPrices",
  "productUnits",
  "bundleComponents",
  "productVariants",
  "products",
  "branches",
  "users",
  "idempotencyKeys",
  "auditLogs",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/**
 * تجهيز بيئة الاختبار:
 * - فروع ومستخدمين.
 * - مواد خام:
 *   - صنف 1 (خام ورق - R1): كلفة 1.00
 *   - صنف 6 (خام تجليد - R2): كلفة 2.00
 * - مكوّنات البكج:
 *   - صنف 2 (دفتر مصنّع A): يدخل في وصفته 2.5 ورقة من R1 (مضاعف الدفعة المطلوب = 2)
 *   - صنف 3 (دفتر مصنّع B): يدخل في وصفته 1 ورقة من R1 و3 وحدات من R2
 *   - صنف 4 (قلم تجاري C): لا وصفة له (مكوّن تجاري غير مصنّع)
 * - البكج المركب:
 *   - صنف 10 (بكج مدرسي - Bundle 100): يتكوّن من 2 دفتر A + 1 دفتر B + 1 قلم C
 */
async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES", isActive: true },
  ]);
  await d.insert(s.users).values({
    id: 1,
    openId: "t",
    name: "admin",
    role: "admin",
    loginMethod: "local",
  });

  await d.insert(s.products).values([
    { id: 1, name: "خام ورق", isBundle: false, isActive: true },
    { id: 2, name: "دفتر مصنع A", isBundle: false, isActive: true },
    { id: 3, name: "دفتر مصنع B", isBundle: false, isActive: true },
    { id: 4, name: "قلم تجاري C", isBundle: false, isActive: true },
    { id: 6, name: "خام تجليد", isBundle: false, isActive: true },
    { id: 10, name: "بكج مدرسي متكامل", isBundle: true, isActive: true },
  ]);

  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "RAW-PAPER", costPrice: "1.00", isActive: true },
    { id: 2, productId: 2, sku: "BOOK-A", costPrice: "2.50", isActive: true },
    { id: 3, productId: 3, sku: "BOOK-B", costPrice: "7.00", isActive: true },
    { id: 4, productId: 4, sku: "PEN-C", costPrice: "0.50", isActive: true },
    { id: 6, productId: 6, sku: "RAW-COVER", costPrice: "2.00", isActive: true },
    { id: 100, productId: 10, sku: "BND-SCHOOL", costPrice: "12.50", isActive: true },
  ]);

  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "دفتر", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "دفتر", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "قلم", conversionFactor: "1", isBaseUnit: true },
    { id: 6, variantId: 6, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 100, variantId: 100, unitName: "بكج", conversionFactor: "1", isBaseUnit: true },
  ]);

  // مكوّنات البكج 100:
  // 2 من دفتر A + 1 من دفتر B + 1 من قلم C
  await d.insert(s.bundleComponents).values([
    { id: 1, bundleVariantId: 100, componentVariantId: 2, componentBaseQuantity: 2, sortOrder: 1 },
    { id: 2, bundleVariantId: 100, componentVariantId: 3, componentBaseQuantity: 1, sortOrder: 2 },
    { id: 3, bundleVariantId: 100, componentVariantId: 4, componentBaseQuantity: 1, sortOrder: 3 },
  ]);

  // وصفة لدفتر A (معامِل كسري 2.5 ورقة => يتطلب مضاعف دفعة = 2)
  await createRecipe(
    {
      name: "وصفة دفتر A",
      outputVariantId: 2,
      outputProductUnitId: 2,
      laborPerOutputBase: "0.50",
      wasteStdPct: "0.00",
      lines: [{ inputVariantId: 1, qtyPerOutputBase: "2.5000" }],
    },
    actor
  );

  // وصفة لدفتر B (1 ورقة + 3 تجليد => مضاعف الدفعة = 1)
  await createRecipe(
    {
      name: "وصفة دفتر B",
      outputVariantId: 3,
      outputProductUnitId: 3,
      laborPerOutputBase: "1.00",
      wasteStdPct: "0.00",
      lines: [
        { inputVariantId: 1, qtyPerOutputBase: "1.0000" },
        { inputVariantId: 6, qtyPerOutputBase: "3.0000" },
      ],
    },
    actor
  );

  // الأرصدة الافتتاحية في الفرع 1:
  // - دفتر A: 5 وحدات
  // - دفتر B: 2 وحدات
  // - قلم C: 15 وحدة
  // - خام ورق R1: 40 ورقة
  // - خام تجليد R2: 100 قطعة
  await d.insert(s.branchStock).values([
    { variantId: 2, branchId: 1, quantity: 5 },
    { variantId: 3, branchId: 1, quantity: 2 },
    { variantId: 4, branchId: 1, quantity: 15 },
    { variantId: 1, branchId: 1, quantity: 40 },
    { variantId: 6, branchId: 1, quantity: 100 },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

async function stock(variantId: number, branchId = 1): Promise<number> {
  const r = (
    await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(
        sql`${s.branchStock.variantId} = ${variantId} AND ${s.branchStock.branchId} = ${branchId}`
      )
  )[0];
  return Number(r?.q ?? 0);
}

describe("مولّد إنتاج مكوّنات البكج: analyzeBundleRequirements", () => {
  it("يحسب العجز الصافي ويجبر الدفعة للمضاعف الشرعي الصحيح", async () => {
    // نطلب 10 بكجات:
    // دفتر A: مطلوب 10 * 2 = 20. المتوفر = 5. العجز = 15.
    // معامِل دفتر A هو 2.5 => المضاعف المطلوب = 2.
    // عجز 15 فردي لا يقبل القسمة على 2 => يجب جبر الدفعة المقترحة إلى 16 (فائض مؤقت 1).
    // دفتر B: مطلوب 10 * 1 = 10. المتوفر = 2. العجز = 8.
    // معامِل دفتر B صحيح (1 و 3) => المضاعف = 1 => الدفعة المقترحة = 8 (فائض = 0).
    // قلم C: مطلوب 10 * 1 = 10. المتوفر = 15 => العجز = 0.
    const res = await analyzeBundleRequirements({
      bundleVariantId: 100,
      bundleQuantity: 10,
      branchId: 1,
      mode: "NET_SHORTAGE",
    });

    expect(res.bundleVariantId).toBe(100);
    expect(res.bundleName).toBe("بكج مدرسي متكامل");
    expect(res.requestedBundleQty).toBe(10);
    expect(res.components).toHaveLength(3);

    const compA = res.components.find((c) => c.variantId === 2);
    expect(compA).toBeDefined();
    expect(compA?.totalRequiredQty).toBe(20);
    expect(compA?.onHandStock).toBe(5);
    expect(compA?.shortageQty).toBe(15);
    expect(compA?.requiredBatchMultiple).toBe(2);
    expect(compA?.suggestedBatchQty).toBe(16);
    expect(compA?.surplusBufferQty).toBe(1);
    expect(compA?.isManufactured).toBe(true);

    const compB = res.components.find((c) => c.variantId === 3);
    expect(compB).toBeDefined();
    expect(compB?.totalRequiredQty).toBe(10);
    expect(compB?.onHandStock).toBe(2);
    expect(compB?.shortageQty).toBe(8);
    expect(compB?.requiredBatchMultiple).toBe(1);
    expect(compB?.suggestedBatchQty).toBe(8);
    expect(compB?.surplusBufferQty).toBe(0);
    expect(compB?.isManufactured).toBe(true);

    const compC = res.components.find((c) => c.variantId === 4);
    expect(compC).toBeDefined();
    expect(compC?.totalRequiredQty).toBe(10);
    expect(compC?.onHandStock).toBe(15);
    expect(compC?.shortageQty).toBe(0);
    expect(compC?.suggestedBatchQty).toBe(0);
    expect(compC?.isManufactured).toBe(false);
  });

  it("يجمّع المواد الخام المشتركة ويكشف عنق الزجاجة الحاكم بدقة", async () => {
    // إنتاج مقترح:
    // دفتر A: دفعة 16 => يستهلك 16 * 2.5 = 40 ورقة من R1.
    // دفتر B: دفعة 8 => يستهلك 8 * 1 = 8 ورقة من R1، و 8 * 3 = 24 قطعة من R2.
    // إجمالي R1 (ورق) المطلوب = 40 + 8 = 48 ورقة.
    // رصيد R1 الحالي في الفرع = 40 ورقة فقط! => عجز 8 ورقات (غير كافٍ).
    // إجمالي R2 (تجليد) المطلوب = 24 قطعة. المتوفر = 100 => كافٍ.
    const res = await analyzeBundleRequirements({
      bundleVariantId: 100,
      bundleQuantity: 10,
      branchId: 1,
      mode: "NET_SHORTAGE",
    });

    expect(res.aggregatedMaterials).toHaveLength(2);

    const matR1 = res.aggregatedMaterials.find((m) => m.materialVariantId === 1);
    expect(matR1).toBeDefined();
    expect(matR1?.totalRequiredBase).toBe("48.0000");
    expect(matR1?.availableInBranch).toBe(40);
    expect(matR1?.isSufficient).toBe(false);
    expect(matR1?.deficitBase).toBe("8.0000");

    const matR2 = res.aggregatedMaterials.find((m) => m.materialVariantId === 6);
    expect(matR2).toBeDefined();
    expect(matR2?.totalRequiredBase).toBe("24.0000");
    expect(matR2?.availableInBranch).toBe(100);
    expect(matR2?.isSufficient).toBe(true);
    expect(matR2?.deficitBase).toBe("0");

    // عنق الزجاجة:
    // استهلاك R1 لكل بكج = (2 * 2.5) + (1 * 1) = 6 ورقات.
    // رصيد R1 = 40. أقصى بكجات ممكنة من R1 = floor(40 / 6) = 6 بكجات.
    // استهلاك R2 لكل بكج = 3 قطع. رصيد R2 = 100 => floor(100 / 3) = 33 بكج.
    // قلم C التجاري = 15 متوفر / 1 لكل بكج = 15 بكج.
    // العامل المحدِّد الحاكم = R1 (خام ورق) بسقف 6 بكجات.
    expect(res.maxBundlesPossible).toBe(6);
    expect(res.limitingFactorType).toBe("RAW_MATERIAL");
    expect(res.limitingFactorName).toBe("خام ورق");
  });

  it("يحترم وضع FULL_QUANTITY ويتجاهل أرصدة المكونات الجاهزة في حساب الدفعة", async () => {
    const res = await analyzeBundleRequirements({
      bundleVariantId: 100,
      bundleQuantity: 10,
      branchId: 1,
      mode: "FULL_QUANTITY",
    });

    const compA = res.components.find((c) => c.variantId === 2);
    expect(compA?.shortageQty).toBe(20); // 10 * 2 بالكامل
    expect(compA?.suggestedBatchQty).toBe(20);

    const compB = res.components.find((c) => c.variantId === 3);
    expect(compB?.shortageQty).toBe(10); // 10 * 1 بالكامل
    expect(compB?.suggestedBatchQty).toBe(10);
  });

  it("يرفض تحليل صنف غير موجود أو صنف ليس بكجاً", async () => {
    await expect(
      analyzeBundleRequirements({
        bundleVariantId: 999999,
        bundleQuantity: 5,
        branchId: 1,
        mode: "NET_SHORTAGE",
      })
    ).rejects.toThrow("البكج المطلوب غير موجود");

    // صنف 1 منتج عادي ليس بكجاً
    await expect(
      analyzeBundleRequirements({
        bundleVariantId: 1,
        bundleQuantity: 5,
        branchId: 1,
        mode: "NET_SHORTAGE",
      })
    ).rejects.toThrow("المنتج المحدد ليس بكجاً مركّباً");

    // صنف معطّل
    const d = db();
    await d.update(s.products).set({ isActive: false }).where(eq(s.products.id, 10));
    await expect(
      analyzeBundleRequirements({
        bundleVariantId: 100,
        bundleQuantity: 5,
        branchId: 1,
        mode: "NET_SHORTAGE",
      })
    ).rejects.toThrow("البكج المطلوب معطّل");
  });
});

describe("مولّد إنتاج مكوّنات البكج: produceBundleComponents", () => {
  it("ينفّذ أوامر الإنتاج بنجاح داخل معاملة موحدة ويربط docGroupRef ويحدّث كلفة البكج", async () => {
    // نوفّر رصيداً كافياً من R1 كي تنجح العملية:
    await db()
      .update(s.branchStock)
      .set({ quantity: 200 })
      .where(sql`${s.branchStock.variantId} = 1 AND ${s.branchStock.branchId} = 1`);

    const result = await produceBundleComponents(
      {
        bundleVariantId: 100,
        bundleQuantity: 10,
        branchId: 1,
        clientRequestId: "req-bundle-test-01",
        notes: "تشغيلة تجريبية للبكج",
        batches: [
          { variantId: 2, recipeId: 1, batchQty: 16, scrapQty: 0, laborPerUnit: "0.50" },
          { variantId: 3, recipeId: 2, batchQty: 8, scrapQty: 0, laborPerUnit: "1.00" },
        ],
      },
      actor
    );

    expect(result.bundleVariantId).toBe(100);
    expect(result.bundleDocGroupRef).toContain("BND-1-");
    expect(result.orders).toHaveLength(2);

    // التحقق من أوامر الإنتاج المولدة:
    const orderA = result.orders.find((o) => o.variantId === 2);
    expect(orderA).toBeDefined();
    expect(orderA?.goodQty).toBe(16);

    const orderB = result.orders.find((o) => o.variantId === 3);
    expect(orderB).toBeDefined();
    expect(orderB?.goodQty).toBe(8);

    // التحقق من تحديث الأرصدة في المخزن:
    // دفتر A: كان 5 + 16 = 21
    expect(await stock(2)).toBe(21);
    // دفتر B: كان 2 + 8 = 10
    expect(await stock(3)).toBe(10);
    // خام R1: كان 200 - 40 (من A) - 8 (من B) = 152
    expect(await stock(1)).toBe(152);
    // خام R2: كان 100 - 24 (من B) = 76
    expect(await stock(6)).toBe(76);

    // التحقق من كلفة البكج المحدثة عبر syncBundlesContainingComponents
    // نظام الإنتاج يطبّق المتوسط المرجح WAVG على المخرجات:
    // دفتر A: 5 وحدات قديمة @ 2.50 + 16 جديدة @ 3.00 => (12.5 + 48) / 21 = 2.88
    // دفتر B: 2 وحدات قديمة @ 7.00 + 8 جديدة @ 8.00 => (14 + 64) / 10 = 7.80
    // قلم C: 0.50
    // كلفة وحدة البكج = (2 * 2.88095) + (1 * 7.80) + (1 * 0.50) = 5.7619 + 7.80 + 0.50 = 14.06
    expect(Number(result.updatedBundleUnitCost)).toBeCloseTo(14.06, 2);

    // فحص ملاحظات أوامر الإنتاج وتضمين docGroupRef:
    const poList = await db()
      .select({ notes: s.productionOrders.notes })
      .from(s.productionOrders);
    expect(poList).toHaveLength(2);
    for (const po of poList) {
      expect(po.notes).toContain(result.bundleDocGroupRef);
    }
  });

  it("ذرّية تامة (Rollback): نقص رصيد لأحد المكونات يلغي المعاملة كاملة دون أي أثر جانبي", async () => {
    // رصيد R1 الحالي 40 فقط.
    // دفتر A يحتاج 40 ورقة (سيمر لو نُفّذ منفرداً).
    // دفتر B يحتاج 8 ورقات إضافية (سيفشل بسبب نفاد R1).
    // بفضل withTx: لا يجب أن يُنشأ أمر لـ A ولا يتم خصم أي ورقة!
    const initialStockA = await stock(2);
    const initialStockB = await stock(3);
    const initialStockR1 = await stock(1);

    await expect(
      produceBundleComponents(
        {
          bundleVariantId: 100,
          bundleQuantity: 10,
          branchId: 1,
          clientRequestId: "req-bundle-fail-01",
          batches: [
            { variantId: 2, recipeId: 1, batchQty: 16 },
            { variantId: 3, recipeId: 2, batchQty: 8 },
          ],
        },
        actor
      )
    ).rejects.toThrow();

    // التحقق الصارم من التراجع الكامل (Zero Side-effects):
    expect(await stock(2)).toBe(initialStockA);
    expect(await stock(3)).toBe(initialStockB);
    expect(await stock(1)).toBe(initialStockR1);

    const poCount = (
      await db().select({ count: sql`count(*)` }).from(s.productionOrders)
    )[0] as { count: number };
    expect(Number(poCount.count)).toBe(0);
  });

  it("Idempotency: إعادة إرسال نفس clientRequestId لا تكرر الإنتاج أو تحركات المخزون", async () => {
    await db()
      .update(s.branchStock)
      .set({ quantity: 200 })
      .where(sql`${s.branchStock.variantId} = 1 AND ${s.branchStock.branchId} = 1`);

    const call1 = await produceBundleComponents(
      {
        bundleVariantId: 100,
        bundleQuantity: 5,
        branchId: 1,
        clientRequestId: "idempotent-key-xyz",
        batches: [{ variantId: 2, recipeId: 1, batchQty: 2 }],
      },
      actor
    );

    const stockAfterFirst = await stock(2);

    const call2 = await produceBundleComponents(
      {
        bundleVariantId: 100,
        bundleQuantity: 5,
        branchId: 1,
        clientRequestId: "idempotent-key-xyz",
        batches: [{ variantId: 2, recipeId: 1, batchQty: 2 }],
      },
      actor
    );

    // نفس رقم الأمر ولا تكرار
    expect(call2.orders[0].productionOrderId).toBe(call1.orders[0].productionOrderId);
    expect(await stock(2)).toBe(stockAfterFirst);
  });

  it("يرفض أصناف مكررة أو أصناف غير منتمية للبكج أو بكج معطّل", async () => {
    const d = db();
    // صنف غير منتمٍ للبكج (صنف 6 مادة خام وليس مكوّن في البكج 100)
    await expect(
      produceBundleComponents(
        {
          bundleVariantId: 100,
          bundleQuantity: 5,
          branchId: 1,
          clientRequestId: "req-err-foreign",
          batches: [{ variantId: 6, recipeId: 1, batchQty: 2 }],
        },
        actor
      )
    ).rejects.toThrow("صنف غير منتمٍ للبكج");

    // أصناف مكررة في نفس الطلب
    await expect(
      produceBundleComponents(
        {
          bundleVariantId: 100,
          bundleQuantity: 5,
          branchId: 1,
          clientRequestId: "req-err-dup",
          batches: [
            { variantId: 2, recipeId: 1, batchQty: 2 },
            { variantId: 2, recipeId: 1, batchQty: 4 },
          ],
        },
        actor
      )
    ).rejects.toThrow("تكرار في أصناف الدفعات");

    // بكج معطّل
    await d.update(s.products).set({ isActive: false }).where(eq(s.products.id, 10));
    await expect(
      produceBundleComponents(
        {
          bundleVariantId: 100,
          bundleQuantity: 5,
          branchId: 1,
          clientRequestId: "req-err-inactive",
          batches: [{ variantId: 2, recipeId: 1, batchQty: 2 }],
        },
        actor
      )
    ).rejects.toThrow("البكج المطلوب معطّل");
  });

  it("يرفض دفعات بكمية صفر أو تالف يساوي الدفعة", async () => {
    await expect(
      produceBundleComponents(
        {
          bundleVariantId: 100,
          bundleQuantity: 5,
          branchId: 1,
          clientRequestId: "req-err-zero",
          batches: [{ variantId: 2, recipeId: 1, batchQty: 0 }],
        },
        actor
      )
    ).rejects.toThrow("كمية دفعة غير صالحة");

    await expect(
      produceBundleComponents(
        {
          bundleVariantId: 100,
          bundleQuantity: 5,
          branchId: 1,
          clientRequestId: "req-err-all-scrap",
          batches: [{ variantId: 2, recipeId: 1, batchQty: 4, scrapQty: 4 }],
        },
        actor
      )
    ).rejects.toThrow("كمية التالف تساوي أو تتجاوز حجم الدفعة");
  });

  it("يرفض تحليل أو إنتاج بكج يحتوي على مكوّن معطّل", async () => {
    const d = db();
    // تعطيل أحد مكونات البكج (دفتر مصنع A - صنف 2)
    await d.update(s.products).set({ isActive: false }).where(eq(s.products.id, 2));

    await expect(
      analyzeBundleRequirements(
        {
          bundleVariantId: 100,
          quantity: 5,
          branchId: 1,
          mode: "NET_DEFICIT",
        },
        actor
      )
    ).rejects.toThrow(/مكوّن معطّل في البكج/);

    await expect(
      produceBundleComponents(
        {
          bundleVariantId: 100,
          bundleQuantity: 5,
          branchId: 1,
          clientRequestId: "req-err-deactivated-comp",
          batches: [{ variantId: 3, recipeId: 2, batchQty: 5 }],
        },
        actor
      )
    ).rejects.toThrow(/مكوّن معطّل في البكج/);
  });

  it("يرفض تحليل بكج إذا كانت وصفة أحد مكوّناته بلا بنود مدخلات (0 أسطر)", async () => {
    const d = db();
    // إفراغ سطور وصفة دفتر A
    await d.delete(s.productionRecipeLines).where(eq(s.productionRecipeLines.recipeId, 1));

    await expect(
      analyzeBundleRequirements(
        {
          bundleVariantId: 100,
          quantity: 5,
          branchId: 1,
          mode: "NET_DEFICIT",
        },
        actor
      )
    ).rejects.toThrow(/وصفة مكوّن بلا مدخلات/);
  });

  it("Idempotency: يضمن ثبات بصمة المجموعة docGroupRef حتى مع الرموز الخاصة في clientRequestId", async () => {
    const specialReqId = "REQ_$$!!@@--123";

    const res1 = await produceBundleComponents(
      {
        bundleVariantId: 100,
        bundleQuantity: 2,
        branchId: 1,
        clientRequestId: specialReqId,
        batches: [{ variantId: 2, recipeId: 1, batchQty: 4 }],
      },
      actor
    );

    const res2 = await produceBundleComponents(
      {
        bundleVariantId: 100,
        bundleQuantity: 2,
        branchId: 1,
        clientRequestId: specialReqId,
        batches: [{ variantId: 2, recipeId: 1, batchQty: 4 }],
      },
      actor
    );

    expect(res1.bundleDocGroupRef).toBe(res2.bundleDocGroupRef);
    expect(res1.orders[0].productionOrderId).toBe(res2.orders[0].productionOrderId);
  });
});

