import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { approveStockAdjustment, requestStockAdjustment } from "../inventory/adjustmentApproval";
import { createProduction, cancelProduction } from "../productionService";
import { createRecipe } from "../recipeService";
import { createStockTransfer, receiveStockTransfer } from "../transferService";
import { withTx } from "../tx";
import { createWorkOrder } from "../workOrder/create";

const TABLES = [
  "auditLogs", "accountingEntries", "stockAdjustmentRequests", "stockTransferLineBundleComponents", "stockTransferLines", "stockTransfers",
  "productionLines", "productionOrders", "productionRecipeLines", "productionRecipes",
  "workOrderMaterials", "workOrders", "idempotencyKeys", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products", "users", "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function resetAndSeed() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الثاني", code: "B2", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "admin-fi", name: "المدير", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "cash-fi", name: "الكاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "wh-fi", name: "المخزن", role: "warehouse", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.products).values([
    { id: 1, name: "مادة" },
    { id: 2, name: "منتج" },
    { id: 3, name: "منتج ثان" },
  ]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "MAT", costPrice: "10.00" },
    { id: 2, productId: 2, sku: "OUT", costPrice: "10.00" },
    { id: 3, productId: 3, sku: "OUT2", costPrice: "10.00" },
  ]);
  await db().insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await db().insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 10 },
    { variantId: 3, branchId: 1, quantity: 10 },
  ]);
}

beforeEach(resetAndSeed);

describe("حواجز سلامة المخزون والتكلفة", () => {
  it("يرفض self-convert حتى لو أرسل العميل مفتاح التجاوز", async () => {
    await expect(createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 1 }],
      outputs: [{ variantId: 1, baseQuantity: 1 }],
      laborCost: "1000000",
      allowSelfConvert: true,
    }, { userId: 1, branchId: 1 })).rejects.toThrow(/مدخلاً ومخرجاً/);
  });

  it("يرفض نسبة توزيع سالبة ولو كان مجموع النسب 100%", async () => {
    await expect(createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 10 }],
      outputs: [
        { variantId: 2, baseQuantity: 1, manualSharePct: "200" },
        { variantId: 3, baseQuantity: 1, manualSharePct: "-100" },
      ],
    }, { userId: 1, branchId: 1 })).rejects.toThrow(/بين 0% و100%/);
  });

  it("يرفض كسر حجم الدفعة بدلاً من قصّه بصمت", async () => {
    const recipe = await createRecipe({
      name: "وصفة صحيحة",
      outputVariantId: 2,
      outputProductUnitId: 2,
      lines: [{ inputVariantId: 1, qtyPerOutputBase: "1" }],
    }, { userId: 1, branchId: 1 });
    await expect(createProduction({
      branchId: 1,
      run: { recipeId: recipe.recipeId, batchQty: 10.5, scrapQty: 0 },
    }, { userId: 1, branchId: 1 })).rejects.toThrow(/عدداً صحيحاً/);
  });

  it("إلغاء الإنتاج يفك مساهمة الدفعة من WAVG", async () => {
    const made = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 5 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, { userId: 1, branchId: 1 });
    expect((await db().select({ c: s.productVariants.costPrice }).from(s.productVariants).where(eq(s.productVariants.id, 2)))[0].c)
      .toBe("7.50");
    await cancelProduction(made.productionOrderId, { userId: 1, branchId: 1, role: "admin" });
    expect((await db().select({ c: s.productVariants.costPrice }).from(s.productVariants).where(eq(s.productVariants.id, 2)))[0].c)
      .toBe("10.00");
  });

  it("إلغاء الإنتاج يعكس قيمة WAVG المرسملة فعلياً دون ضياع سنت القسمة", async () => {
    const made = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 10 }], // كلفة 100.00
      outputs: [{ variantId: 2, baseQuantity: 3 }], // 33.33 × 3 = 99.99 داخل WAVG
    }, { userId: 1, branchId: 1 });
    expect((await db().select({ c: s.productVariants.costPrice }).from(s.productVariants)
      .where(eq(s.productVariants.id, 2)))[0].c).toBe("15.38");

    await cancelProduction(made.productionOrderId, { userId: 1, branchId: 1, role: "admin" });

    // طرح allocatedCost=100 كان يعيدها 9.99؛ الصحيح عكس 99.99 التي دخلت WAVG فعلاً.
    expect((await db().select({ c: s.productVariants.costPrice }).from(s.productVariants)
      .where(eq(s.productVariants.id, 2)))[0].c).toBe("10.00");
  });

  it("إلغاء الإنتاج يعيد المدخلات بقيمتها التاريخية ويمزج WAVG اللاحق", async () => {
    const made = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 10 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, { userId: 1, branchId: 1 });

    // بعد الاستهلاك: 90 @ 10.00. نمثّل استلاماً لاحقاً 10 @ 30.00 بصورة حالته النهائية:
    // 100 وحدة بقيمة متوسطة 12.00. الإلغاء يجب أن يعيد 10 @ 10.00 التاريخية، فيصبح
    // WAVG = (100×12 + 10×10) / 110 = 11.82، لا أن يبقى 12.00.
    await db().update(s.branchStock).set({ quantity: 100 }).where(and(
      eq(s.branchStock.variantId, 1),
      eq(s.branchStock.branchId, 1),
    ));
    await db().update(s.productVariants).set({ costPrice: "12.00" }).where(eq(s.productVariants.id, 1));

    await cancelProduction(made.productionOrderId, { userId: 1, branchId: 1, role: "admin" });

    const material = (await db().select({ cost: s.productVariants.costPrice })
      .from(s.productVariants).where(eq(s.productVariants.id, 1)))[0];
    const stock = (await db().select({ quantity: s.branchStock.quantity })
      .from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(stock.quantity).toBe(110);
    expect(material.cost).toBe("11.82");
  });

  it("إلغاء مخرج الإنتاج يرفض السالب حتى لو كان المنتج يُباع بالطلب", async () => {
    const made = await createProduction({
      branchId: 1,
      inputs: [{ variantId: 1, baseQuantity: 5 }],
      outputs: [{ variantId: 2, baseQuantity: 10 }],
    }, { userId: 1, branchId: 1 });
    await db().update(s.products).set({ allowBackorder: true }).where(eq(s.products.id, 2));
    // الإجمالي العالمي ما زال 20، فيمر فحص فك WAVG؛ لكن فرع الإنتاج لا يحمل إلا 5 من
    // المخرَج المطلوب سحبه (10). لو احترم الإلغاء allowBackorder لهبط الفرع إلى -5 كذباً.
    await db().update(s.branchStock).set({ quantity: 5 }).where(and(
      eq(s.branchStock.variantId, 2),
      eq(s.branchStock.branchId, 1),
    ));
    await db().insert(s.branchStock).values({ variantId: 2, branchId: 2, quantity: 15 });

    await expect(cancelProduction(
      made.productionOrderId,
      { userId: 1, branchId: 1, role: "admin" },
    )).rejects.toThrow(/المخزون غير كافٍ/);

    expect((await db().select({ quantity: s.branchStock.quantity }).from(s.branchStock).where(and(
      eq(s.branchStock.variantId, 2),
      eq(s.branchStock.branchId, 1),
    )))[0].quantity).toBe(5);
    expect((await db().select({ status: s.productionOrders.status }).from(s.productionOrders)
      .where(eq(s.productionOrders.id, made.productionOrderId)))[0].status).toBe("CONFIRMED");
  });

  it("يرفض اعتماد تسوية إذا تغيّرت WAVG بعد الطلب", async () => {
    const request = await requestStockAdjustment(
      { variantId: 1, branchId: 1, targetQuantity: 110, notes: "تصحيح" },
      { userId: 3, branchId: 1, role: "warehouse" },
    );
    await db().update(s.productVariants).set({ costPrice: "11.00" }).where(eq(s.productVariants.id, 1));
    await expect(approveStockAdjustment(request.requestId, { userId: 1, branchId: 1, role: "admin" }))
      .rejects.toThrow(/تغيّرت تكلفة/);
  });

  it("يقيّم عجز التحويل بلقطة تكلفة الإرسال لا WAVG اللاحقة", async () => {
    const sent = await withTx((tx) => createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId: 1, baseQuantity: 5 }],
      createdBy: 1,
    }));
    await db().update(s.productVariants).set({ costPrice: "99.00" }).where(eq(s.productVariants.id, 1));
    const lines = await db().select().from(s.stockTransferLines).where(eq(s.stockTransferLines.transferId, sent.transferId));
    await withTx((tx) => receiveStockTransfer(tx, {
      transferId: sent.transferId,
      lines: [{ lineId: Number(lines[0].id), quantityReceived: 4, note: "وحدة مفقودة" }],
      actor: { userId: 1, role: "admin", branchId: 1 },
    }));
    const loss = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `TRANSFER_LOSS:${sent.transferId}`)))[0];
    expect(loss.cost).toBe("10.00");
  });

  it("لا يسمح للكاشير بإدخال تكلفة عمالة لأمر الشغل", async () => {
    await expect(createWorkOrder({
      branchId: 1,
      title: "طباعة",
      salePrice: "100.00",
      laborCost: "50.00",
    }, { userId: 2, branchId: 1, role: "cashier" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
