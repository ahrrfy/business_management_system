import { eq, sql } from "drizzle-orm";
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
  "auditLogs", "accountingEntries", "stockAdjustmentRequests", "stockTransferLines", "stockTransfers",
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
