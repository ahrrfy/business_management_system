import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money } from "../money";
import {
  analyzeMultiRecipeRequirements,
  produceMultiRecipeBatches,
} from "../productionService";
import { createRecipe } from "../recipeService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
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
  "workOrders",
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
 * - فرع ومستخدم.
 * - مواد خام:
 *   - صنف 1 (خام ورق - R1): كلفة 1.00
 *   - صنف 6 (خام تجليد - R2): كلفة 2.00
 * - منتجات تامة:
 *   - صنف 2 (دفتر A): وصفة 1 تتطلب 2.5 ورقة R1 (مضاعف الدفعة = 2)
 *   - صنف 3 (دفتر B): وصفة 2 تتطلب 1 ورقة R1 و 3 تجليد R2 (مضاعف الدفعة = 1)
 *   - صنف 5 (خدمة طباعة): وصفة خدمة (غير قابلة للإنتاج المخزني)
 * - بكج 100 يتضمن دفتر A ودفتر B.
 */
async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES", isActive: true },
  ]);
  await d.insert(s.users).values({
    id: 1,
    openId: "admin-test",
    name: "admin",
    role: "admin",
    loginMethod: "local",
  });

  await d.insert(s.products).values([
    { id: 1, name: "خام ورق R1", isBundle: false, isService: false, isActive: true },
    { id: 2, name: "دفتر A", isBundle: false, isService: false, isActive: true },
    { id: 3, name: "دفتر B", isBundle: false, isService: false, isActive: true },
    { id: 5, name: "خدمة طباعة", isBundle: false, isService: true, isActive: true },
    { id: 6, name: "خام تجليد R2", isBundle: false, isService: false, isActive: true },
    { id: 10, name: "بكج مدرسي", isBundle: true, isService: false, isActive: true },
  ]);

  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "RAW-PAPER", costPrice: "1.00", isActive: true },
    { id: 2, productId: 2, sku: "NOTEBOOK-A", costPrice: "2.50", isActive: true },
    { id: 3, productId: 3, sku: "NOTEBOOK-B", costPrice: "7.00", isActive: true },
    { id: 5, productId: 5, sku: "SRV-PRINT", costPrice: "0.00", isActive: true },
    { id: 6, productId: 6, sku: "RAW-COVER", costPrice: "2.00", isActive: true },
    { id: 100, productId: 10, sku: "BND-SCHOOL", costPrice: "9.50", isActive: true },
  ]);

  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "دفتر", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "دفتر", conversionFactor: "1", isBaseUnit: true },
    { id: 5, variantId: 5, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
    { id: 6, variantId: 6, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 100, variantId: 100, unitName: "طقم", conversionFactor: "1", isBaseUnit: true },
  ]);

  // بكج يحتوي على دفتر A ودفتر B
  await d.insert(s.bundleComponents).values([
    { id: 1, bundleVariantId: 100, componentVariantId: 2, componentBaseQuantity: 1, sortOrder: 1 },
    { id: 2, bundleVariantId: 100, componentVariantId: 3, componentBaseQuantity: 1, sortOrder: 2 },
  ]);

  // وصفة 1: دفتر A
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

  // وصفة 2: دفتر B
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

  // وصفة 3: خدمة طباعة
  await createRecipe(
    {
      name: "وصفة خدمة طباعة",
      outputVariantId: 5,
      outputProductUnitId: 5,
      laborPerOutputBase: "0.00",
      wasteStdPct: "0.00",
      lines: [{ inputVariantId: 1, qtyPerOutputBase: "1.0000" }],
    },
    actor
  );

  // الأرصدة الافتتاحية في الفرع 1:
  // - ورق R1: 50 ورقة
  // - تجليد R2: 20 قطعة
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 6, branchId: 1, quantity: 20 },
    { variantId: 2, branchId: 1, quantity: 0 },
    { variantId: 3, branchId: 1, quantity: 0 },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

async function getStock(variantId: number, branchId = 1): Promise<number> {
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

describe("الإنتاج المتعدد: analyzeMultiRecipeRequirements", () => {
  it("يحسب احتياجات وصفات متعددة ويجمع المواد الخام المشتركة ويكشف العجز", async () => {
    // وصفة 1 (دفتر A): كمية 2 (مضاعف سليم) => تستهلك 2 * 2.5 = 5 ورق R1
    // وصفة 2 (دفتر B): كمية 4 => تستهلك 4 * 1 = 4 ورق R1 و 4 * 3 = 12 تجليد R2
    // إجمالي ورق R1 = 9 (متوفر 50 => كافٍ)
    // إجمالي تجليد R2 = 12 (متوفر 20 => كافٍ)
    const result = await analyzeMultiRecipeRequirements({
      branchId: 1,
      items: [
        { recipeId: 1, batchQty: 2 },
        { recipeId: 2, batchQty: 4 },
      ],
    });

    expect(result.recipes).toHaveLength(2);
    expect(result.canProduceAll).toBe(true);
    expect(result.limitingFactors).toHaveLength(0);

    // تجميع المواد المشتركة
    const aggPaper = result.aggregatedMaterials.find((m) => m.materialVariantId === 1);
    expect(aggPaper).toBeDefined();
    expect(aggPaper?.totalRequiredBase).toBe("9.0000");
    expect(aggPaper?.isSufficient).toBe(true);
    expect(aggPaper?.availableInBranch).toBe(50);

    const aggCover = result.aggregatedMaterials.find((m) => m.materialVariantId === 6);
    expect(aggCover).toBeDefined();
    expect(aggCover?.totalRequiredBase).toBe("12.0000");
    expect(aggCover?.isSufficient).toBe(true);
    expect(aggCover?.availableInBranch).toBe(20);

    // التكاليف:
    // ورق: 9 * 1.00 = 9.00
    // تجليد: 12 * 2.00 = 24.00
    // إجمالي مواد = 33.00
    // عمالة وصفة 1 = 2 * 0.50 = 1.00
    // عمالة وصفة 2 = 4 * 1.00 = 4.00
    // إجمالي عمالة = 5.00
    // إجمالي تقديري = 38.00
    expect(result.totalMaterialsCost).toBe("33.00");
    expect(result.totalLaborCost).toBe("5.00");
    expect(result.totalEstimatedCost).toBe("38.00");
  });

  it("يكشف العجز ويحدد عوامل عنق الزجاجة عند نقص المواد الخام", async () => {
    // نطلب كمية تجليد تتجاوز المتوفر (المتوفر 20)
    // وصفة 2 بكمية 10 => تحتاج 30 تجليد
    const result = await analyzeMultiRecipeRequirements({
      branchId: 1,
      items: [
        { recipeId: 1, batchQty: 2 },
        { recipeId: 2, batchQty: 10 },
      ],
    });

    expect(result.canProduceAll).toBe(false);
    expect(result.limitingFactors).toHaveLength(1);
    expect(result.limitingFactors[0].materialVariantId).toBe(6);
    expect(result.limitingFactors[0].availableInBranch).toBe(20);
    expect(result.limitingFactors[0].totalRequiredBase).toBe("30.0000");
    expect(result.limitingFactors[0].deficitBase).toBe("10.0000");

    const cover = result.aggregatedMaterials.find((m) => m.materialVariantId === 6);
    expect(cover?.isSufficient).toBe(false);
  });

  it("يتحقق من قيد قابلية القسمة للدفعات (batch divisibility)", async () => {
    // وصفة 1 تتطلب 2.5 ورقة لكل وحدة => مضاعف الدفعة الإلزامي = 2
    // تمرير دفعة فردية 3 يجب أن يُعلَّم كـ غير صالح
    const result = await analyzeMultiRecipeRequirements({
      branchId: 1,
      items: [
        { recipeId: 1, batchQty: 3 },
        { recipeId: 2, batchQty: 2 },
      ],
    });

    const r1 = result.recipes.find((r) => r.recipeId === 1);
    expect(r1?.requiredBatchMultiple).toBe(2);
    expect(r1?.isMultipleValid).toBe(false);
    expect(result.canProduceAll).toBe(false);
  });

  it("يرفض تحليل وصفة غير موجودة أو معطلة أو خدمة أو تكرار بالطلب", async () => {
    // غير موجودة
    await expect(
      analyzeMultiRecipeRequirements({
        branchId: 1,
        items: [{ recipeId: 999, batchQty: 2 }],
      })
    ).rejects.toThrow(/الوصفة المطلوبة غير موجودة/);

    // وصفة خدمة
    await expect(
      analyzeMultiRecipeRequirements({
        branchId: 1,
        items: [{ recipeId: 3, batchQty: 1 }],
      })
    ).rejects.toThrow(/وصفة خدمة غير قابلة للإنتاج المخزني/);

    // تكرار في القائمة
    await expect(
      analyzeMultiRecipeRequirements({
        branchId: 1,
        items: [
          { recipeId: 1, batchQty: 2 },
          { recipeId: 1, batchQty: 4 },
        ],
      })
    ).rejects.toThrow(/تكرار في الوصفات المحددة/);

    // كمية صفر
    await expect(
      analyzeMultiRecipeRequirements({
        branchId: 1,
        items: [{ recipeId: 1, batchQty: 0 }],
      })
    ).rejects.toThrow(/كمية دفعة غير صالحة/);
  });
});

describe("الإنتاج المتعدد: produceMultiRecipeBatches", () => {
  it("ينفذ إنتاج وصفات متعددة ذرّياً مع تشعيب مفتاح Idempotency وتحديث كلفة البكجات التابعة", async () => {
    const initialRawPaper = await getStock(1); // 50
    const initialRawCover = await getStock(6); // 20
    const initialNotebookA = await getStock(2); // 0
    const initialNotebookB = await getStock(3); // 0

    const clientRequestId = "MULTI-TEST-REQ-001";

    const result = await produceMultiRecipeBatches(
      {
        branchId: 1,
        clientRequestId,
        batches: [
          { recipeId: 1, batchQty: 2, scrapQty: 0 },
          { recipeId: 2, batchQty: 2, scrapQty: 0 },
        ],
      },
      actor
    );

    expect(result.orderCount).toBe(2);
    expect(result.orders).toHaveLength(2);
    expect(result.multiRecipeDocGroupRef).toMatch(/^MULTI-1-/);

    // تحقق من أن أمر الإنتاج لكل وصفة تم إنشاؤه بنجاح
    const order1 = result.orders.find((o) => o.recipeId === 1);
    expect(order1).toBeDefined();
    expect(order1?.goodQty).toBe(2);
    expect(order1?.outputVariantId).toBe(2);

    const order2 = result.orders.find((o) => o.recipeId === 2);
    expect(order2).toBeDefined();
    expect(order2?.goodQty).toBe(2);
    expect(order2?.outputVariantId).toBe(3);

    // تحقق من حركة المخزون:
    // وصفة 1: 2 * 2.5 = 5 ورق
    // وصفة 2: 2 * 1 = 2 ورق، 2 * 3 = 6 تجليد
    // استهلاك الورق = 7 => المتبقي 50 - 7 = 43
    // استهلاك التجليد = 6 => المتبقي 20 - 6 = 14
    expect(await getStock(1)).toBe(43);
    expect(await getStock(6)).toBe(14);
    expect(await getStock(2)).toBe(2);
    expect(await getStock(3)).toBe(2);

    // تحقق من مزامنة كلفة البكج التابع 100:
    // كلفة دفتر A = (5 * 1.00 + 1.00 عمالة) / 2 = 3.00
    // كلفة دفتر B = (2 * 1.00 + 6 * 2.00 + 2.00 عمالة) / 2 = 8.00
    // البكج 100 يتكون من 1 من دفتر A و 1 من دفتر B => كلفة البكج = 3.00 + 8.00 = 11.00
    const [bundleVariant] = await db()
      .select({ costPrice: s.productVariants.costPrice })
      .from(s.productVariants)
      .where(eq(s.productVariants.id, 100));
    expect(bundleVariant.costPrice).toBe("11.00");
  });

  it("Idempotency: إعادة إرسال نفس clientRequestId لا تكرر الإنتاج أو حركات المخزون", async () => {
    const clientRequestId = "MULTI-IDEMPOTENT-001";

    const res1 = await produceMultiRecipeBatches(
      {
        branchId: 1,
        clientRequestId,
        batches: [
          { recipeId: 1, batchQty: 2 },
          { recipeId: 2, batchQty: 2 },
        ],
      },
      actor
    );

    const paperStockAfterFirst = await getStock(1);
    const prodCountAfterFirst = (await db().select().from(s.productionOrders)).length;

    // إعادة نفس الطلب بالضبط
    const res2 = await produceMultiRecipeBatches(
      {
        branchId: 1,
        clientRequestId,
        batches: [
          { recipeId: 1, batchQty: 2 },
          { recipeId: 2, batchQty: 2 },
        ],
      },
      actor
    );

    // يجب أن يعيد نفس المعرفات
    expect(res2.orders[0].productionOrderId).toBe(res1.orders[0].productionOrderId);
    expect(res2.orders[1].productionOrderId).toBe(res1.orders[1].productionOrderId);

    // لم يتم إنشاء أوامر إنتاج جديدة
    const prodCountAfterSecond = (await db().select().from(s.productionOrders)).length;
    expect(prodCountAfterSecond).toBe(prodCountAfterFirst);

    // لم يتم خصم مخزون إضافي
    expect(await getStock(1)).toBe(paperStockAfterFirst);
  });

  it("ذرّية تامة (Rollback): نقص رصيد لأحد الوصفات يلغي كامل المعاملة دون أي أثر جانبي", async () => {
    const initialRawPaper = await getStock(1); // 50
    const initialNotebookA = await getStock(2); // 0
    const initialNotebookB = await getStock(3); // 0

    // وصفة 1 تطلب كمية مقبولة، لكن وصفة 2 تطلب كمية تجليد تفوق المتوفر (تحتاج 200 تجليد، المتوفر 20)
    await expect(
      produceMultiRecipeBatches(
        {
          branchId: 1,
          clientRequestId: "FAIL-ROLLBACK-TEST",
          batches: [
            { recipeId: 1, batchQty: 2 },
            { recipeId: 2, batchQty: 70 }, // 70 * 3 = 210 تجليد > 20
          ],
        },
        actor
      )
    ).rejects.toThrow();

    // التأكد من عدم إنشاء أي أمر إنتاج
    const totalOrders = (await db().select().from(s.productionOrders)).length;
    expect(totalOrders).toBe(0);

    // التأكد من عدم تحرك أي مخزون (لا إنتاج لدفتر A ولا خصم للورق)
    expect(await getStock(1)).toBe(initialRawPaper);
    expect(await getStock(2)).toBe(initialNotebookA);
    expect(await getStock(3)).toBe(initialNotebookB);
  });

  it("يرفض دفعات بكمية صفر أو تالف يساوي الدفعة أو تكرار في الطلب", async () => {
    await expect(
      produceMultiRecipeBatches(
        {
          branchId: 1,
          clientRequestId: "BAD-QTY",
          batches: [{ recipeId: 1, batchQty: 0 }],
        },
        actor
      )
    ).rejects.toThrow(/كمية دفعة غير صالحة/);

    await expect(
      produceMultiRecipeBatches(
        {
          branchId: 1,
          clientRequestId: "BAD-SCRAP",
          batches: [{ recipeId: 1, batchQty: 2, scrapQty: 2 }],
        },
        actor
      )
    ).rejects.toThrow(/كمية الهدر تتجاوز حجم الدفعة/);

    await expect(
      produceMultiRecipeBatches(
        {
          branchId: 1,
          clientRequestId: "DUP-BATCH",
          batches: [
            { recipeId: 1, batchQty: 2 },
            { recipeId: 1, batchQty: 4 },
          ],
        },
        actor
      )
    ).rejects.toThrow(/تكرار في دفعات الوصفة/);
  });

  it("ينفذ الإنتاج مع تخصيص أجور العمالة لكل وحدة وربط أمر شغل اختياري", async () => {
    const clientRequestId = "MULTI-CUSTOM-LABOR-001";

    await db().insert(s.workOrders).values({
      id: 456,
      orderNumber: "WO-456",
      branchId: 1,
      title: "طلب طباعة خاص",
    });

    const res = await produceMultiRecipeBatches(
      {
        branchId: 1,
        clientRequestId,
        linkedWorkOrderId: 456,
        notes: "تشغيل متعدد مع تخصيص عمالة",
        batches: [
          // عمالة مخصصة 5.50 للوحدة بدل الافتراضي 0.50
          { recipeId: 1, batchQty: 2, scrapQty: 0, laborPerUnit: "5.50" },
        ],
      },
      actor
    );

    expect(res.orders).toHaveLength(1);
    const orderId = res.orders[0].productionOrderId;

    const [orderRow] = await db()
      .select({
        laborCost: s.productionOrders.laborCost,
        linkedWorkOrderId: s.productionOrders.linkedWorkOrderId,
        notes: s.productionOrders.notes,
      })
      .from(s.productionOrders)
      .where(eq(s.productionOrders.id, orderId));

    // 2 * 5.50 = 11.00 عمالة
    expect(orderRow.laborCost).toBe("11.00");
    expect(orderRow.linkedWorkOrderId).toBe(456);
    expect(orderRow.notes).toContain("تشغيل متعدد مع تخصيص عمالة");
  });

  it("يرفض ترحيل دفعة غير متوافقة مع قيد قابلية القسمة (batch divisibility) مسبقاً", async () => {
    // وصفة 1 تتطلب 2.5 ورقة => مضاعفها المطلوب = 2
    // تمرير كمية فردية (3) يجب أن يُرفض فوراً برسالة دقيقة
    await expect(
      produceMultiRecipeBatches(
        {
          branchId: 1,
          clientRequestId: "FAIL-DIVISIBILITY-BATCH",
          batches: [{ recipeId: 1, batchQty: 3 }],
        },
        actor
      )
    ).rejects.toThrow(/كمية دفعة غير متوافقة مع مضاعفات الوصفة/);
  });

  it("Idempotency: يضمن ثبات بصمة المجموعة docGroupRef حتى مع الرموز الخاصة في clientRequestId", async () => {
    const specialReqId = "REQ_$$!!@@--123";

    const res1 = await produceMultiRecipeBatches(
      {
        branchId: 1,
        clientRequestId: specialReqId,
        batches: [{ recipeId: 1, batchQty: 2 }],
      },
      actor
    );

    const res2 = await produceMultiRecipeBatches(
      {
        branchId: 1,
        clientRequestId: specialReqId,
        batches: [{ recipeId: 1, batchQty: 2 }],
      },
      actor
    );

    expect(res1.multiRecipeDocGroupRef).toBe(res2.multiRecipeDocGroupRef);
    expect(res1.orders[0].productionOrderId).toBe(res2.orders[0].productionOrderId);
  });

  it("يرفض تحليل أو ترحيل وصفات بلا أسطر مكوّنات (0 أسطر)", async () => {
    const d = db();
    // إفراغ سطور وصفة 1
    await d.delete(s.productionRecipeLines).where(eq(s.productionRecipeLines.recipeId, 1));

    await expect(
      analyzeMultiRecipeRequirements(
        {
          branchId: 1,
          items: [{ recipeId: 1, batchQty: 2 }],
        },
        actor
      )
    ).rejects.toThrow(/الوصفة بلا مكوّنات/);

    await expect(
      produceMultiRecipeBatches(
        {
          branchId: 1,
          clientRequestId: "req-err-empty-lines",
          batches: [{ recipeId: 1, batchQty: 2 }],
        },
        actor
      )
    ).rejects.toThrow(/الوصفة بلا مكوّنات/);
  });

  it("يراعي reservationStock ويخصم الحجوزات عند احتساب العجز (ATP Availability) ويكشف النقص ويحمي من الأرصدة السالبة", async () => {
    const d = db();
    // الرصيد القائم لخام الورق variantId: 1 هو 50
    // نحجز 45 وحدة في reservationStock فيصبح المتاح الفعلي ATP = 50 - 45 = 5
    await d.insert(s.reservationStock).values({
      variantId: 1,
      branchId: 1,
      reservedBase: 45,
    });

    // وصفة 1 تتطلب 2.5 ورقة للدفعة الواحدة، نطلب دفعة بحجم 4 => الاحتياج 10 ورقات
    const res1 = await analyzeMultiRecipeRequirements(
      {
        branchId: 1,
        items: [{ recipeId: 1, batchQty: 4 }],
      },
      actor
    );

    const mat1 = res1.aggregatedMaterials.find((m) => m.materialVariantId === 1);
    expect(mat1).toBeDefined();
    expect(mat1!.availableInBranch).toBe(5);
    expect(mat1!.totalRequiredBase).toBe("10.0000");
    expect(mat1!.isSufficient).toBe(false);
    expect(mat1!.deficitBase).toBe("5.0000");
    expect(res1.canProduceAll).toBe(false);

    // حالة فائض الحجز (حجز 60 ورقة والرصيد القائم 50): المتاح يجب ألا يكون سالباً في DTO (clamped to 0)
    await d
      .update(s.reservationStock)
      .set({ reservedBase: 60 })
      .where(and(eq(s.reservationStock.variantId, 1), eq(s.reservationStock.branchId, 1)));

    const res2 = await analyzeMultiRecipeRequirements(
      {
        branchId: 1,
        items: [{ recipeId: 1, batchQty: 4 }],
      },
      actor
    );

    const mat2 = res2.aggregatedMaterials.find((m) => m.materialVariantId === 1);
    expect(mat2).toBeDefined();
    expect(mat2!.availableInBranch).toBe(0);
    expect(mat2!.totalRequiredBase).toBe("10.0000");
    expect(mat2!.isSufficient).toBe(false);
    expect(mat2!.deficitBase).toBe("10.0000");
    expect(res2.canProduceAll).toBe(false);
  });
});


