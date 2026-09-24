/**
 * اختبارات تكامل وصفات الخدمات وأوامر الشغل:
 * 1. استرجاع وصفة المنتج getRecipeForProduct للخدمات والسلع.
 * 2. اشتقاق مواد الوصفة تلقائياً عند إنشاء أمر شغل لخدمة ذات وصفة، ومنع إدراج الخدمة كمادة.
 * 3. الشفاء الذاتي عند بدء التنفيذ startWorkOrder: إزالة سطر الخدمة غير الصالح، واشتقاق مواد الوصفة، وصرف المواد الخام بنجاح.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createRecipe, getRecipeForProduct } from "../recipeService";
import { createWorkOrder } from "../workOrder/create";
import { startWorkOrder } from "../workOrder/lifecycle";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "workOrderControlRequests",
  "workOrderEvents",
  "workOrderDesignApprovals",
  "workOrderDesignRevisions",
  "taskEvents",
  "tasks",
  "workOrderMaterials",
  "workOrderImages",
  "workOrders",
  "serviceTypes",
  "branchStock",
  "shifts",
  "customers",
  "productPrices",
  "productionRecipeLines",
  "productionRecipes",
  "productionOrders",
  "productUnits",
  "productVariants",
  "products",
  "branches",
  "users",
];

const MGR = { userId: 1, branchId: 1, role: "manager" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr1", name: "مدير 1", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "tech1", name: "فني 1", role: "print_operator", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "زبون تجريبي", defaultPriceTier: "RETAIL", currentBalance: "0" });

  // 1. خدمة طباعة علم (isService = true)
  // 2. مادة خام: قماش علم (isService = false)
  // 3. مادة خام: سارية علم (isService = false)
  await d.insert(s.products).values([
    { id: 10, name: "خدمة طباعة علم مع سارية", isService: true, isActive: true },
    { id: 20, name: "قماش علم خام", isService: false, isActive: true },
    { id: 30, name: "سارية معدنية", isService: false, isActive: true },
    { id: 40, name: "خدمة تصميم خالصة", isService: true, isActive: true },
  ]);

  await d.insert(s.productVariants).values([
    { id: 100, productId: 10, sku: "FLAG-SRV", costPrice: "0.00", isActive: true },
    { id: 200, productId: 20, sku: "FABRIC-RAW", costPrice: "3000.00", isActive: true },
    { id: 300, productId: 30, sku: "POLE-RAW", costPrice: "5000.00", isActive: true },
    { id: 400, productId: 40, sku: "DESIGN-SRV", costPrice: "0.00", isActive: true },
  ]);

  await d.insert(s.productUnits).values([
    { id: 1000, variantId: 100, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 2000, variantId: 200, unitName: "متر", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 3000, variantId: 300, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 4000, variantId: 400, unitName: "عمل", conversionFactor: "1", isBaseUnit: true, isActive: true },
  ]);

  // رصيد مخزني للمواد الخام في الفرع 1
  await d.insert(s.branchStock).values([
    { variantId: 200, branchId: 1, quantity: 100 },
    { variantId: 300, branchId: 1, quantity: 50 },
  ]);
}

describe("خدمات ووصفات أوامر الشغل — اختبارات تكاملية", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("getRecipeForProduct يعرض حالة الوصفة والمواد لبطاقة المنتج بدقة", async () => {
    // قبل إنشاء أي وصفة
    const before = await getRecipeForProduct(10);
    expect(before.product.id).toBe(10);
    expect(before.product.isService).toBe(true);
    expect(before.primaryVariantId).toBe(100);
    expect(before.primaryProductUnitId).toBe(1000);
    expect(before.recipe).toBeNull();
    expect(before.allRecipes).toHaveLength(0);

    // إنشاء وصفة للخدمة: 2 متر قماش + 1 سارية
    const created = await createRecipe(
      {
        name: "وصفة طباعة علم مع سارية",
        outputVariantId: 100,
        outputProductUnitId: 1000,
        laborPerOutputBase: "1500.00",
        wasteStdPct: "0.05",
        lines: [
          { inputVariantId: 200, inputProductUnitId: 2000, qtyPerOutputBase: "2.0000" },
          { inputVariantId: 300, inputProductUnitId: 3000, qtyPerOutputBase: "1.0000" },
        ],
      },
      MGR,
    );
    expect(created.recipeId).toBeGreaterThan(0);

    // بعد إنشاء الوصفة: بطاقة المنتج تقرأ الوصفة كاملة بمكوناتها
    const after = await getRecipeForProduct(10);
    expect(after.recipe).not.toBeNull();
    expect(after.recipe?.name).toBe("وصفة طباعة علم مع سارية");
    expect(after.recipe?.lines).toHaveLength(2);
    expect(after.recipe?.lines[0].inputVariantId).toBe(200);
    expect(after.recipe?.lines[0].inputProductName).toBe("قماش علم خام");
    expect(after.recipe?.lines[0].qtyPerOutputBase).toBe("2.0000");
    expect(after.recipe?.lines[1].inputVariantId).toBe(300);
    expect(after.recipe?.lines[1].inputProductName).toBe("سارية معدنية");
    expect(after.recipe?.lines[1].qtyPerOutputBase).toBe("1.0000");
  });

  it("createWorkOrder يشتق تلقائياً مواد الوصفة للخدمة ويمنع إدراج الخدمة كمادة", async () => {
    // إنشاء الوصفة
    await createRecipe(
      {
        name: "وصفة طباعة علم مع سارية",
        outputVariantId: 100,
        outputProductUnitId: 1000,
        laborPerOutputBase: "1000.00",
        lines: [
          { inputVariantId: 200, inputProductUnitId: 2000, qtyPerOutputBase: "2.0000" },
          { inputVariantId: 300, inputProductUnitId: 3000, qtyPerOutputBase: "1.0000" },
        ],
      },
      MGR,
    );

    // محاكاة إنشاء أمر شغل لكمية 3 أعلام: الواجهة ترسل خطأ صنف الخدمة نفسه في materials
    const woRes = await createWorkOrder(
      {
        branchId: 1,
        customerId: 1,
        baseVariantId: 100,
        baseProductUnitId: 1000,
        title: "طلب 3 أعلام",
        quantity: 3,
        salePrice: "45000.00",
        // حتى لو أرسل العميل صنف الخدمة في المواد، يجب استبعاده تلقائياً
        materials: [{ variantId: 100, baseQuantity: 3 }],
        clientRequestId: randomUUID(),
      },
      MGR,
    );

    expect(woRes.workOrderId).toBeGreaterThan(0);

    // فحص المواد المسجلة في جدول workOrderMaterials
    const savedMaterials = await db()
      .select()
      .from(s.workOrderMaterials)
      .where(eq(s.workOrderMaterials.workOrderId, woRes.workOrderId));

    // يجب ألا تحتوي المواد على صنف الخدمة 100
    expect(savedMaterials.some((m) => Number(m.variantId) === 100)).toBe(false);

    // يجب أن تحتوي على المواد الخام مشتقة ومضروبة في الكمية (3):
    // قماش: 2 * 3 = 6 متر
    // سارية: 1 * 3 = 3 قطع
    const fabricMat = savedMaterials.find((m) => Number(m.variantId) === 200);
    const poleMat = savedMaterials.find((m) => Number(m.variantId) === 300);

    expect(fabricMat).toBeDefined();
    expect(fabricMat?.baseQuantity).toBe(6);
    expect(poleMat).toBeDefined();
    expect(poleMat?.baseQuantity).toBe(3);
  });

  it("startWorkOrder يشفي ذاتياً الأوامر القائمة التي تحتوي على صنف الخدمة ويصرف المواد الخام", async () => {
    // إنشاء الوصفة
    await createRecipe(
      {
        name: "وصفة طباعة علم مع سارية",
        outputVariantId: 100,
        outputProductUnitId: 1000,
        lines: [
          { inputVariantId: 200, inputProductUnitId: 2000, qtyPerOutputBase: "2.0000" },
          { inputVariantId: 300, inputProductUnitId: 3000, qtyPerOutputBase: "1.0000" },
        ],
      },
      MGR,
    );

    // إنشاء أمر شغل يدوي يحاكي الحالة المعطوبة القديمة: صنف الخدمة 100 موجود في workOrderMaterials
    const [insertedWo] = await db()
      .insert(s.workOrders)
      .values({
        orderNumber: "WO-TEST-5342",
        branchId: 1,
        customerId: 1,
        baseVariantId: 100,
        baseProductUnitId: 1000,
        title: "أمر شغل معطوب تاريخياً",
        quantity: 2,
        salePrice: "30000.00",
        status: "RECEIVED",
        baseConsumesInventory: false,
      })
      .$returningId();

    const legacyWoId = insertedWo.id;

    // إدراج صنف الخدمة مباشرة في المواد (الحالة القديمة المعطوبة)
    await db().insert(s.workOrderMaterials).values({
      workOrderId: legacyWoId,
      variantId: 100,
      baseQuantity: 2,
      unitCost: "0.00",
    });

    // تنفيذ بدء أمر الشغل startWorkOrder
    const startRes = await startWorkOrder(legacyWoId, MGR);
    expect(startRes.status).toBe("IN_PROGRESS");

    // التحقق من الشفاء الذاتي في قاعدة البيانات:
    // 1. حذف سطر الخدمة 100
    // 2. إدراج سطور القماش والسارية (2 * 2 = 4 متر قماش، 1 * 2 = 2 سارية)
    const currentMaterials = await db()
      .select()
      .from(s.workOrderMaterials)
      .where(eq(s.workOrderMaterials.workOrderId, legacyWoId));

    expect(currentMaterials.some((m) => Number(m.variantId) === 100)).toBe(false);
    const fabric = currentMaterials.find((m) => Number(m.variantId) === 200);
    const pole = currentMaterials.find((m) => Number(m.variantId) === 300);
    expect(fabric?.baseQuantity).toBe(4);
    expect(pole?.baseQuantity).toBe(2);

    // التحقق من خصم المخزون الحقيقي للمواد الخام:
    // قماش: 100 - 4 = 96
    // سارية: 50 - 2 = 48
    const stockFabric = (
      await db()
        .select()
        .from(s.branchStock)
        .where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 200)))
    )[0];
    const stockPole = (
      await db()
        .select()
        .from(s.branchStock)
        .where(and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 300)))
    )[0];

    expect(Number(stockFabric.quantity)).toBe(96);
    expect(Number(stockPole.quantity)).toBe(48);
  });

  it("startWorkOrder لخدمة خالصة بلا وصفة يشفي سطر الخدمة وينتقل لحالة IN_PROGRESS بسلاسة", async () => {
    // خدمة تصميم 400 ليس لها أي وصفة
    const [insertedWo] = await db()
      .insert(s.workOrders)
      .values({
        orderNumber: "WO-TEST-DESIGN-1",
        branchId: 1,
        customerId: 1,
        baseVariantId: 400,
        baseProductUnitId: 4000,
        title: "طلب خدمة تصميم خالصة",
        quantity: 1,
        salePrice: "10000.00",
        status: "RECEIVED",
        baseConsumesInventory: false,
      })
      .$returningId();

    const woId = insertedWo.id;

    // تم إدراج صنف الخدمة في المواد خطأ
    await db().insert(s.workOrderMaterials).values({
      workOrderId: woId,
      variantId: 400,
      baseQuantity: 1,
      unitCost: "0.00",
    });

    // بدء التنفيذ: يشفي السطر ويستمر بلا استهلاك مخزون وبلا أخطاء
    const startRes = await startWorkOrder(woId, MGR);
    expect(startRes.status).toBe("IN_PROGRESS");

    const mats = await db()
      .select()
      .from(s.workOrderMaterials)
      .where(eq(s.workOrderMaterials.workOrderId, woId));
    expect(mats).toHaveLength(0);
  });
});
