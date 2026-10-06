import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createProduction, runPreview } from "../productionService";
import { createRecipe, substituteRecipeMaterial } from "../recipeService";

const adminActor = { userId: 1, branchId: 1, role: "ADMIN" };
const managerActor = { userId: 2, branchId: 1, role: "MANAGER" };
const workerActor = { userId: 3, branchId: 1, role: "WORKER" };

function makeCtx(user: any) {
  return {
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user,
  } as any;
}

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "inventoryMovements",
  "productionLines",
  "productionOrders",
  "productionRecipeLines",
  "productionRecipes",
  "bundleComponents",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "branches",
  "users",
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
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "manager", name: "manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "worker", name: "worker", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);

  // المنتجات:
  // 1: ورق أبيض (مادة خام أصلية)
  // 2: ورق كريمي (مادة بديلة صالحة)
  // 3: غلاف بلاستيك (مكون ثانٍ في الوصفة)
  // 4: خدمة تغليف (خدمة - لا تصلح كبديل)
  // 5: بكج هدايا (بكج - لا يصلح كبديل)
  // 6: ورق تالف/معطل (معطل - لا يصلح كبديل)
  // 10: دفتر مدرسي (منتج ناتج الوصفة)
  // 20: بكج قرطاسية مدرسي (يحتوي دفتر مدرسي كأحد مكوناته لفحص syncBundles)
  await d.insert(s.products).values([
    { id: 1, name: "ورق أبيض", isService: false, isBundle: false, isActive: true },
    { id: 2, name: "ورق كريمي", isService: false, isBundle: false, isActive: true },
    { id: 3, name: "غلاف بلاستيك", isService: false, isBundle: false, isActive: true },
    { id: 4, name: "خدمة تغليف", isService: true, isBundle: false, isActive: true },
    { id: 5, name: "بكج هدايا", isService: false, isBundle: true, isActive: true },
    { id: 6, name: "ورق معطل", isService: false, isBundle: false, isActive: false },
    { id: 10, name: "دفتر مدرسي", isService: false, isBundle: false, isActive: true },
    { id: 20, name: "بكج قرطاسية مدرسي", isService: false, isBundle: true, isActive: true },
  ]);

  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAPER-WHITE", costPrice: "10.00", isActive: true },
    { id: 2, productId: 2, sku: "PAPER-CREAM", costPrice: "15.00", isActive: true },
    { id: 3, productId: 3, sku: "COVER-PLASTIC", costPrice: "5.00", isActive: true },
    { id: 4, productId: 4, sku: "SRV-WRAP", costPrice: "0.00", isActive: true },
    { id: 5, productId: 5, sku: "BNDL-GIFT", costPrice: "0.00", isActive: true },
    { id: 6, productId: 6, sku: "PAPER-OFF", costPrice: "10.00", isActive: false },
    { id: 10, productId: 10, sku: "NOTEBOOK", costPrice: "0.00", isActive: true },
    { id: 20, productId: 20, sku: "BNDL-SCHOOL", costPrice: "0.00", isActive: true },
  ]);

  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 2, variantId: 2, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 4, variantId: 4, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 5, variantId: 5, unitName: "بكج", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 6, variantId: 6, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true, isActive: false },
    { id: 7, variantId: 2, unitName: "علبة", conversionFactor: "100", isBaseUnit: false, isActive: true },
    { id: 10, variantId: 10, unitName: "دفتر", conversionFactor: "1", isBaseUnit: true, isActive: true },
    { id: 20, variantId: 20, unitName: "حقيبة", conversionFactor: "1", isBaseUnit: true, isActive: true },
  ]);

  // أرصدة الفرع:
  // ورق أبيض: 0 (نافذ - out of stock)
  // ورق كريمي: 5000 (متوفر)
  // غلاف: 2000 (متوفر)
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 0 },
    { variantId: 2, branchId: 1, quantity: 5000 },
    { variantId: 3, branchId: 1, quantity: 2000 },
  ]);
}

async function createTestRecipe(): Promise<number> {
  const recipe = await createRecipe(
    {
      name: "وصفة دفتر مدرسي 50 ورقة",
      outputVariantId: 10,
      outputProductUnitId: 10,
      laborPerOutputBase: "2.00",
      wasteStdPct: "0.00",
      lines: [
        { inputVariantId: 1, qtyPerOutputBase: "50.0000" }, // ورق أبيض 50 ورقة
        { inputVariantId: 3, qtyPerOutputBase: "1.0000" },  // غلاف 1 قطعة
      ],
    },
    adminActor,
  );
  return recipe.recipeId;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("الاستبدال المؤقت (Ad-hoc) في معاينة وترحيل الإنتاج", () => {
  it("ينعكس الاستبدال المؤقت في المعاينة runPreview مع التكلفة والمخزون الحي", async () => {
    const recipeId = await createTestRecipe();

    // 1. المعاينة بدون استبدال: المادة 1 نافذة فـ i.short يجب أن يكون true
    const previewWithoutSub = await runPreview({
      recipeId,
      batchQty: 10,
      branchId: 1,
    });
    expect(previewWithoutSub.anyShort).toBe(true);
    const linePaperWhite = previewWithoutSub.inputs.find((i) => i.variantId === 1);
    expect(linePaperWhite).toBeDefined();
    expect(linePaperWhite?.short).toBe(true);
    expect(linePaperWhite?.isSubstituted).toBe(false);

    // 2. المعاينة مع استبدال الورق الأبيض (1) بالورق الكريمي (2)
    const previewWithSub = await runPreview({
      recipeId,
      batchQty: 10,
      branchId: 1,
      materialSubstitutions: [
        {
          originalVariantId: 1,
          substituteVariantId: 2,
          qtyPerOutputBase: "50.0000",
        },
      ],
    });

    // الورق الكريمي متوفر (5000) والمطلوب 500 => لا يوجد نقص في الورق
    expect(previewWithSub.anyShort).toBe(false);
    const subLine = previewWithSub.inputs.find((i) => i.variantId === 2);
    expect(subLine).toBeDefined();
    expect(subLine?.isSubstituted).toBe(true);
    expect(subLine?.originalVariantId).toBe(1);
    expect(subLine?.short).toBe(false);
    expect(subLine?.consumed).toBe(500); // 50 * 10
    // تكلفة الورق الكريمي: 15.00 * 500 = 7500.00
    expect(subLine?.lineCost).toBe("7500.00");
  });

  it("يستهلك createProduction المادة البديلة ويسجل الاستبدال في الملاحظات دون تغيير الوصفة", async () => {
    const recipeId = await createTestRecipe();

    // تشغيل إنتاج 10 دفاتر مع استبدال الورق الأبيض بالورق الكريمي
    const order = await createProduction(
      {
        branchId: 1,
        run: {
          recipeId,
          batchQty: 10,
          scrapQty: 0,
          materialSubstitutions: [
            {
              originalVariantId: 1,
              substituteVariantId: 2,
              qtyPerOutputBase: "50.0000",
            },
          ],
        },
        notes: "أمر إنتاج تجريبي مع بديل إسعافي",
      },
      adminActor,
    );

    expect(order.productionOrderId).toBeGreaterThan(0);

    // تحقق من سطور الإنتاج الفعلية
    const lines = await db()
      .select()
      .from(s.productionLines)
      .where(eq(s.productionLines.productionOrderId, order.productionOrderId));

    const inputLines = lines.filter((l) => l.direction === "INPUT");
    expect(inputLines.some((l) => l.variantId === 2)).toBe(true); // البديل كريمي
    expect(inputLines.some((l) => l.variantId === 1)).toBe(false); // الأبيض لم يُستهلك

    // تحقق من خصم المخزون
    const creamStock = (
      await db()
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(sql`${s.branchStock.variantId} = 2 AND ${s.branchStock.branchId} = 1`)
    )[0];
    expect(Number(creamStock?.q)).toBe(5000 - 500); // خُصم 500

    const whiteStock = (
      await db()
        .select({ q: s.branchStock.quantity })
        .from(s.branchStock)
        .where(sql`${s.branchStock.variantId} = 1 AND ${s.branchStock.branchId} = 1`)
    )[0];
    expect(Number(whiteStock?.q)).toBe(0); // رصيد الأبيض كما هو دون تغيير

    // تحقق من تسجيل الملاحظة التوثيقية في أمر الإنتاج
    const [po] = await db()
      .select({ notes: s.productionOrders.notes })
      .from(s.productionOrders)
      .where(eq(s.productionOrders.id, order.productionOrderId));
    expect(po?.notes).toContain("استبدال مؤقت: #1 ← #2");

    // الوصفة الأصلية لم تتغير سطورها
    const recipeLines = await db()
      .select()
      .from(s.productionRecipeLines)
      .where(eq(s.productionRecipeLines.recipeId, recipeId));
    expect(recipeLines.some((l) => l.inputVariantId === 1)).toBe(true);
    expect(recipeLines.some((l) => l.inputVariantId === 2)).toBe(false);
  });

  it("يرفض الترحيل إذا كان استهلاك المادة البديلة ليس عدداً صحيحاً", async () => {
    const recipeId = await createTestRecipe();

    await expect(
      createProduction(
        {
          branchId: 1,
          run: {
            recipeId,
            batchQty: 3, // 3 * 2.5 = 7.5 (ليس عدداً صحيحاً)
            scrapQty: 0,
            materialSubstitutions: [
              {
                originalVariantId: 1,
                substituteVariantId: 2,
                qtyPerOutputBase: "2.5000",
              },
            ],
          },
        },
        adminActor,
      ),
    ).rejects.toThrow(/ليس عدداً صحيحاً/);
  });
});

describe("الاستبدال الدائم للوصفة substituteRecipeMaterial والحوكمة والذرية ومزامنة البكجات", () => {
  it("يرفض الاستبدال الدائم لغير المديرين (دور WORKER)", async () => {
    const recipeId = await createTestRecipe();

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 2,
          qtyPerOutputBase: "50.0000",
          reason: "نفاد المخزون",
        },
        workerActor,
      ),
    ).rejects.toThrow(/غير مصرح باعتماد تعديل الوصفة الدائم/);
  });

  it("ينفذ الاستبدال الدائم بنجاح لدور MANAGER مع 2PL وتحديث السطور والملاحظات", async () => {
    const recipeId = await createTestRecipe();

    const res = await substituteRecipeMaterial(
      {
        recipeId,
        originalVariantId: 1,
        substituteVariantId: 2,
        qtyPerOutputBase: "48.0000",
        reason: "اعتماد الورق الكريمي كمعيار رسمي",
        notes: "تحسين جودة الطباعة",
      },
      managerActor,
    );

    expect(res.success).toBe(true);
    expect(res.qtyPerOutputBase).toBe("48.0000");

    // التحقق من تحديث سطر الوصفة في قاعدة البيانات
    const lines = await db()
      .select()
      .from(s.productionRecipeLines)
      .where(eq(s.productionRecipeLines.recipeId, recipeId));

    expect(lines.some((l) => l.inputVariantId === 1)).toBe(false);
    const newLine = lines.find((l) => l.inputVariantId === 2);
    expect(newLine).toBeDefined();
    expect(newLine?.qtyPerOutputBase).toBe("48.0000");

    // التحقق من توثيق الملاحظة في رأس الوصفة
    const [rHead] = await db()
      .select({ notes: s.productionRecipes.notes })
      .from(s.productionRecipes)
      .where(eq(s.productionRecipes.id, recipeId));
    expect(rHead?.notes).toContain("استبدال المادة #1 بالبديل #2");
    expect(rHead?.notes).toContain("اعتماد الورق الكريمي كمعيار رسمي");
  });

  it("يزامن تكلفة البكجات التابعة تلقائياً عبر syncBundlesContainingComponents", async () => {
    const recipeId = await createTestRecipe();

    // نربط المنتج الناتج من الوصفة (دفتر #10) في بكج مدرسي (#20)
    // البكج يحوي 2 دفتر مدرسي
    await db().insert(s.bundleComponents).values({
      bundleVariantId: 20,
      componentVariantId: 10,
      componentBaseQuantity: 2,
      sortOrder: 0,
    });

    // نحدد كلفة الدفتر الأولية في productVariants
    await db()
      .update(s.productVariants)
      .set({ costPrice: "500.00" })
      .where(eq(s.productVariants.id, 10));

    // عند استبدال مادة الوصفة بالبديل، تُستدعى syncBundlesContainingComponents
    // وتُعاد حساب كلفة البكج 20 = 2 * 500 = 1000.00
    await substituteRecipeMaterial(
      {
        recipeId,
        originalVariantId: 1,
        substituteVariantId: 2,
      },
      adminActor,
    );

    const [bundleVariant] = await db()
      .select({ costPrice: s.productVariants.costPrice })
      .from(s.productVariants)
      .where(eq(s.productVariants.id, 20));

    expect(bundleVariant?.costPrice).toBe("1000.00");
  });
});

describe("حراس الصحة والتحقق (Validation Guards)", () => {
  it("يرفض الاستبدال لمادة غير موجودة في الوصفة", async () => {
    const recipeId = await createTestRecipe();

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 999, // صنف غير مسجل بالوصفة
          substituteVariantId: 2,
        },
        adminActor,
      ),
    ).rejects.toThrow(/ليس مكوّناً مسجلاً في وصفة/);
  });

  it("يرفض الاستبدال إذا كانت المادة البديلة هي ناتج الوصفة نفسه", async () => {
    const recipeId = await createTestRecipe();

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 10, // 10 هو ناتج الوصفة
        },
        adminActor,
      ),
    ).rejects.toThrow(/المنتج الناتج لا يكون مكوّناً من نفسه/);
  });

  it("يرفض الاستبدال إذا كانت المادة البديلة موجودة بالفعل كمكون آخر في الوصفة", async () => {
    const recipeId = await createTestRecipe();

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 3, // 3 (غلاف بلاستيك) موجود أصلاً في الوصفة
        },
        adminActor,
      ),
    ).rejects.toThrow(/المادة البديلة موجودة بالفعل كمكوّن آخر داخل الوصفة/);
  });

  it("يرفض الاستبدال بمادة معطلة", async () => {
    const recipeId = await createTestRecipe();

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 6, // 6 منتج معطل
        },
        adminActor,
      ),
    ).rejects.toThrow(/المادة البديلة أو منتجها معطّل/);
  });

  it("يرفض الاستبدال بخدمة أو بكج", async () => {
    const recipeId = await createTestRecipe();

    // 4 خدمة
    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 4,
        },
        adminActor,
      ),
    ).rejects.toThrow(/المادة البديلة يجب أن تكون مخزوناً خاماً مملوكاً/);

    // 5 بكج
    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 5,
        },
        adminActor,
      ),
    ).rejects.toThrow(/المادة البديلة يجب أن تكون مخزوناً خاماً مملوكاً/);
  });

  it("يرفض الكميات غير الصالحة (سالبة أو صفرية أو أكثر من 4 منازل)", async () => {
    const recipeId = await createTestRecipe();

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 2,
          qtyPerOutputBase: "-5",
        },
        adminActor,
      ),
    ).rejects.toThrow(/كمية المكوّن البديل لكل وحدة ناتج يجب أن تكون موجبة/);

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 2,
          qtyPerOutputBase: "0",
        },
        adminActor,
      ),
    ).rejects.toThrow(/كمية المكوّن البديل لكل وحدة ناتج يجب أن تكون موجبة/);

    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 1,
          substituteVariantId: 2,
          qtyPerOutputBase: "1.12345",
        },
        adminActor,
      ),
    ).rejects.toThrow(/تتجاوز دقة التخزين/);
  });

  it("حراس التحقق في runPreview ترفض الأصناف غير المسجلة والتكرار والخدمات والبكجات", async () => {
    const recipeId = await createTestRecipe();

    // 1. صنف أصلي غير مسجل في الوصفة
    await expect(
      runPreview({
        recipeId,
        batchQty: 10,
        branchId: 1,
        materialSubstitutions: [{ originalVariantId: 999, substituteVariantId: 2 }],
      }),
    ).rejects.toThrow(/ليس مكوّناً مسجلاً في الوصفة/);

    // 2. تكرار المادة الأصلية
    await expect(
      runPreview({
        recipeId,
        batchQty: 10,
        branchId: 1,
        materialSubstitutions: [
          { originalVariantId: 1, substituteVariantId: 2 },
          { originalVariantId: 1, substituteVariantId: 3 },
        ],
      }),
    ).rejects.toThrow(/تكرار استبدال المادة/);

    // 3. الاستبدال بمنتج الناتج نفسه
    await expect(
      runPreview({
        recipeId,
        batchQty: 10,
        branchId: 1,
        materialSubstitutions: [{ originalVariantId: 1, substituteVariantId: 10 }],
      }),
    ).rejects.toThrow(/المنتج الناتج لا يمكن أن يكون مادة بديلة لنفسه/);

    // 4. صنف بديل غير موجود
    await expect(
      runPreview({
        recipeId,
        batchQty: 10,
        branchId: 1,
        materialSubstitutions: [{ originalVariantId: 1, substituteVariantId: 9999 }],
      }),
    ).rejects.toThrow(/تعذّر العثور على الصنف البديل #9999/);

    // 5. صنف بديل معطل
    await expect(
      runPreview({
        recipeId,
        batchQty: 10,
        branchId: 1,
        materialSubstitutions: [{ originalVariantId: 1, substituteVariantId: 6 }],
      }),
    ).rejects.toThrow(/معطّلة/);

    // 6. صنف بديل خدمة أو بكج
    await expect(
      runPreview({
        recipeId,
        batchQty: 10,
        branchId: 1,
        materialSubstitutions: [{ originalVariantId: 1, substituteVariantId: 4 }],
      }),
    ).rejects.toThrow(/غير صالحة للإنتاج/);

    await expect(
      runPreview({
        recipeId,
        batchQty: 10,
        branchId: 1,
        materialSubstitutions: [{ originalVariantId: 1, substituteVariantId: 5 }],
      }),
    ).rejects.toThrow(/غير صالحة للإنتاج/);
  });
});

describe("الاستبدال المتعدد في دفعة واحدة لمادتين مختلفتين بنفس المادة البديلة", () => {
  it("يدعم الاستبدال المتعدد في المعاينة والترحيل ويجمع استهلاك المادة البديلة ويفحص النقص", async () => {
    const recipeId = await createTestRecipe();

    // استبدال المادة 1 والمادة 3 بالبديل 2 في نفس المعاينة
    const preview = await runPreview({
      recipeId,
      batchQty: 10,
      branchId: 1,
      materialSubstitutions: [
        { originalVariantId: 1, substituteVariantId: 2, qtyPerOutputBase: "50.0000" },
        { originalVariantId: 3, substituteVariantId: 2, qtyPerOutputBase: "1.0000" },
      ],
    });

    expect(preview.inputs).toHaveLength(2);
    const line1 = preview.inputs.find((i) => i.originalVariantId === 1);
    const line2 = preview.inputs.find((i) => i.originalVariantId === 3);
    expect(line1).toBeDefined();
    expect(line2).toBeDefined();
    expect(line1?.variantId).toBe(2);
    expect(line2?.variantId).toBe(2);
    expect(line1?.consumed).toBe(500); // 50 * 10
    expect(line2?.consumed).toBe(10);  // 1 * 10
    expect(line1?.originalProductName).toBe("ورق أبيض");
    expect(line2?.originalProductName).toBe("غلاف بلاستيك");
    expect(line1?.short).toBe(false);
    expect(line2?.short).toBe(false);

    // إذا قل الرصيد المتوفر عن المجموع الإجمالي المطلوب (510 وحدات)، مثلاً 505 وحدات، كلاهما يعلّم short: true
    await db()
      .update(s.branchStock)
      .set({ quantity: 505 })
      .where(sql`${s.branchStock.variantId} = 2 AND ${s.branchStock.branchId} = 1`);

    const previewShort = await runPreview({
      recipeId,
      batchQty: 10,
      branchId: 1,
      materialSubstitutions: [
        { originalVariantId: 1, substituteVariantId: 2, qtyPerOutputBase: "50.0000" },
        { originalVariantId: 3, substituteVariantId: 2, qtyPerOutputBase: "1.0000" },
      ],
    });
    expect(previewShort.anyShort).toBe(true);
    expect(previewShort.inputs.find((i) => i.originalVariantId === 1)?.short).toBe(true);
    expect(previewShort.inputs.find((i) => i.originalVariantId === 3)?.short).toBe(true);

    // إعادة الرصيد إلى 5000 وترحيل أمر الإنتاج فعلياً
    await db()
      .update(s.branchStock)
      .set({ quantity: 5000 })
      .where(sql`${s.branchStock.variantId} = 2 AND ${s.branchStock.branchId} = 1`);

    const order = await createProduction(
      {
        branchId: 1,
        run: {
          recipeId,
          batchQty: 10,
          scrapQty: 0,
          materialSubstitutions: [
            { originalVariantId: 1, substituteVariantId: 2, qtyPerOutputBase: "50.0000" },
            { originalVariantId: 3, substituteVariantId: 2, qtyPerOutputBase: "1.0000" },
          ],
        },
      },
      adminActor,
    );

    // التأكد من خصم المجموع الإجمالي (510) من رصيد المادة البديلة
    const [creamStock] = await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(sql`${s.branchStock.variantId} = 2 AND ${s.branchStock.branchId} = 1`);
    expect(Number(creamStock?.q)).toBe(5000 - 510);

    const [po] = await db()
      .select({ notes: s.productionOrders.notes })
      .from(s.productionOrders)
      .where(eq(s.productionOrders.id, order.productionOrderId));
    expect(po?.notes).toContain("استبدال مؤقت: #1 ← #2 · استبدال مؤقت: #3 ← #2");
  });
});

describe("الاستبدال بوحدات قياس غير أساسية والحوكمة وسجل التدقيق auditLogs", () => {
  it("يحفظ الاستبدال الدائم بوحدة قياس غير أساسية inputProductUnitId مع كميتها", async () => {
    const recipeId = await createTestRecipe();

    // استبدال المادة 1 بالبديل 2 مع تحديد وحدة «علبة» (#7) وكمية 0.5000
    const res = await substituteRecipeMaterial(
      {
        recipeId,
        originalVariantId: 1,
        substituteVariantId: 2,
        substituteProductUnitId: 7,
        qtyPerOutputBase: "0.5000",
      },
      adminActor,
    );

    expect(res.success).toBe(true);

    const [updatedLine] = await db()
      .select()
      .from(s.productionRecipeLines)
      .where(sql`${s.productionRecipeLines.recipeId} = ${recipeId} AND ${s.productionRecipeLines.inputVariantId} = 2`);

    expect(updatedLine).toBeDefined();
    expect(updatedLine.inputProductUnitId).toBe(7);
    expect(updatedLine.qtyPerOutputBase).toBe("0.5000");

    // رفض وحدة قياس لا تخص الصنف البديل (الوحدة 7 تخص الصنف 2 وليس الصنف 1)
    await expect(
      substituteRecipeMaterial(
        {
          recipeId,
          originalVariantId: 2,
          substituteVariantId: 1,
          substituteProductUnitId: 7,
        },
        adminActor,
      ),
    ).rejects.toThrow(/وحدة القياس المحددة لا تخص الصنف البديل أو معطلة/);
  });

  it("مسار TRPC للـ substituteMaterial يمنع غير المصرح ويسجل تدقيقاً رسمياً في auditLogs", async () => {
    const recipeId = await createTestRecipe();

    // 1. محاولة استدعاء من عامل لا يملك صلاحية مدير: يُرفض بـ FORBIDDEN
    const workerCaller = appRouter.createCaller(
      makeCtx({ id: 3, role: "cashier", branchId: 1 }),
    );
    await expect(
      workerCaller.production.recipes.substituteMaterial({
        recipeId,
        originalVariantId: 1,
        substituteVariantId: 2,
        qtyPerOutputBase: "50.0000",
        reason: "محاولة استبدال غير مصرح بها",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 2. استدعاء ناجح من الأدمن
    const adminCaller = appRouter.createCaller(
      makeCtx({ id: 1, role: "admin", branchId: 1 }),
    );
    const result = await adminCaller.production.recipes.substituteMaterial({
      recipeId,
      originalVariantId: 1,
      substituteVariantId: 2,
      qtyPerOutputBase: "50.0000",
      reason: "نفاد ورق أبيض واعتماد ورق كريمي",
    });
    expect(result.success).toBe(true);

    // 3. التحقق من كتابة سجل التدقيق في جدول auditLogs
    const logs = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "production.recipe.substitute_material"));

    expect(logs.length).toBeGreaterThanOrEqual(1);
    const targetLog = logs.find((l) => l.entityId === String(recipeId));
    expect(targetLog).toBeDefined();
    expect(targetLog?.entityType).toBe("productionRecipe");
    expect(targetLog?.userId).toBe(1);
    const newVal = targetLog?.newValue as any;
    expect(newVal?.originalVariantId).toBe(1);
    expect(newVal?.substituteVariantId).toBe(2);
    expect(newVal?.qtyPerOutputBase).toBe("50.0000");
    expect(newVal?.reason).toBe("نفاد ورق أبيض واعتماد ورق كريمي");
  });
});

