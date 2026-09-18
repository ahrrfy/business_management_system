// اختبارات بيع خدمات الطباعة (printSaleService): الإيراد + COGS من الوصفة، خصم المواد الصارم،
// رفض نفاد المادة/فساد الوصفة ذرياً، التقريب النقدي IQD، الذمم/الائتمان،
// idempotency، فحص الوردية، وحارس «خدمات فقط». تطابق ثوابت المحرّك المالي المُدقّق.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPrintSale } from "../printSaleService";
import { getShiftReport } from "../shiftService";
import { withTx } from "../tx";
import { assertCreditLimit } from "../../lib/credit";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

const TABLES = [
  "accountingEntries", "receipts", "invoiceItemServiceMaterials", "invoiceItems", "invoices",
  "productionRecipeLines", "productionRecipes", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "customers", "shifts", "branches", "users", "idempotencyKeys",
];

async function reset() {
  // تنظيف ذرّي على اتصال واحد (withTx): FOREIGN_KEY_CHECKS=0 سارية فعلاً عبر كل الحذف.
  // (toggling عبر اتصالات pool متعدّدة + ابتلاع أخطاء TRUNCATE كان يترك جداول نصف-منظّفة
  //  فتفشل البذرة لاحقاً بـFK/سعر مفقود — فلاكي يظهر مع كثرة دورات beforeEach.)
  await withTx(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN", isActive: true },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES", isActive: true },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values([
    { id: 1, name: "عميل آجل", defaultPriceTier: "RETAIL", creditLimit: "5000", currentBalance: "0" },
    { id: 2, name: "عميل بسقف", defaultPriceTier: "RETAIL", creditLimit: "1000", currentBalance: "0" },
  ]);
  // منتجات: مادتان مخزنيتان (ورق/حبر) + خدمتان (PRINT_SERVICE).
  await d.insert(s.products).values([
    { id: 1, name: "ورق A4" },
    { id: 2, name: "حبر أسود" },
    { id: 10, name: "تصوير A4 أبيض/أسود", productType: "PRINT_SERVICE", isService: true },
    { id: 11, name: "تقديم استمارة إلكترونية", productType: "PRINT_SERVICE", isService: true },
    { id: 12, name: "كروت شخصية جاهزة", productType: "PRINT_SERVICE", isService: false },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "MAT-A4", costPrice: "35.00" },
    { id: 2, productId: 2, sku: "MAT-INK", costPrice: "20.00" },
    { id: 10, productId: 10, sku: "SVC-COPY", costPrice: "0.00" },
    { id: 11, productId: 11, sku: "SVC-ESERV", costPrice: "0.00" },
    { id: 12, productId: 12, sku: "CARD-READY", costPrice: "1000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "وحدة", conversionFactor: "1", isBaseUnit: true },
    { id: 10, variantId: 10, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 11, variantId: 11, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
    { id: 12, variantId: 12, unitName: "دفعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 10, priceTier: "RETAIL", price: "250.00" },
    { productUnitId: 11, priceTier: "RETAIL", price: "5000.00" },
    { productUnitId: 12, priceTier: "RETAIL", price: "2000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 12, branchId: 1, quantity: 10 },
  ]);
  // وصفة الخدمة 10: ورقة + حبر لكل وحدة خدمة.
  await d.insert(s.productionRecipes).values([
    { id: 1, name: "[طباعة] تصوير A4 ب/أ", outputVariantId: 10, outputProductUnitId: 10, laborPerOutputBase: "0", wasteStdPct: "0", isActive: true },
    { id: 2, name: "[إنتاج] كروت شخصية", outputVariantId: 12, outputProductUnitId: 12, laborPerOutputBase: "0", wasteStdPct: "0", isActive: true },
  ]);
  await d.insert(s.productionRecipeLines).values([
    { recipeId: 1, inputVariantId: 1, qtyPerOutputBase: "1.0000" },
    { recipeId: 1, inputVariantId: 2, qtyPerOutputBase: "1.0000" },
    { recipeId: 2, inputVariantId: 1, qtyPerOutputBase: "5.0000" },
  ]);
  // وردية مفتوحة على الفرع 1.
  await d.insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, openingBalance: "100000", status: "OPEN", openGuard: "1:1" });
}

beforeEach(async () => { await reset(); await seed(); });

async function stock(variantId: number, branchId = 1): Promise<number | null> {
  const r = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock)
    .where(sql`${s.branchStock.variantId} = ${variantId} AND ${s.branchStock.branchId} = ${branchId}`))[0];
  return r ? Number(r.q) : null;
}
async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
async function entries() { return db().select().from(s.accountingEntries); }
async function movements() { return db().select().from(s.inventoryMovements); }
async function expectNoSaleArtifacts() {
  expect(await db().select().from(s.invoices)).toHaveLength(0);
  expect(await db().select().from(s.invoiceItems)).toHaveLength(0);
  expect(await db().select().from(s.invoiceItemServiceMaterials)).toHaveLength(0);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect(await entries()).toHaveLength(0);
  expect(await movements()).toHaveLength(0);
}

describe("بيع الطباعة: الإيراد + كلفة المواد + خصم المخزون", () => {
  it("بيع نقدي كامل يخصم المواد ويُحتسب COGS من الوصفة", async () => {
    await db().update(s.branchStock).set({ quantity: 5 }).where(sql`${s.branchStock.variantId} IN (1, 2) AND ${s.branchStock.branchId} = 1`);
    const r = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }],
      payment: { amount: "1250", method: "CASH" },
    }, actor);
    expect(r.total).toBe("1250.00");
    expect(r.status).toBe("PAID");
    const inv = await invoice(r.invoiceId);
    expect(inv.total).toBe("1250.00");
    expect(inv.costTotal).toBe("275.00"); // 5×35 + 5×20
    // المواد خُصمت، والخدمة نفسها بلا مخزون ذاتي.
    expect(await stock(1)).toBe(0);
    expect(await stock(2)).toBe(0);
    expect(await stock(10)).toBeNull();
    // قيد البيع: revenue 1250، cost 275، profit 975 + PAYMENT_IN.
    const es = await entries();
    const sale = es.find((e: any) => e.entryType === "SALE")!;
    expect(sale.revenue).toBe("1250.00");
    expect(sale.cost).toBe("275.00");
    expect(sale.profit).toBe("975.00");
    expect(sale.createdBy).toBe(actor.userId);
    expect(sale.createdByNameSnapshot).toBe("admin");
    expect(es.some((e: any) => e.entryType === "PAYMENT_IN" && e.amount === "1250.00")).toBe(true);
    // إيصال منسوب للوردية (تسوية الصندوق).
    const rec = (await db().select().from(s.receipts))[0];
    expect(Number(rec.shiftId)).toBe(1);
    // كلفة وحدة السطر = 275 / 5.
    const item = (await db().select().from(s.invoiceItems))[0];
    expect(item.unitCost).toBe("55.00");
    expect(item.lineCost).toBe("275.00");
    expect(item.serviceMaterialsSnapshotted).toBe(true);
    const snapshots = await db().select().from(s.invoiceItemServiceMaterials)
      .where(eq(s.invoiceItemServiceMaterials.invoiceItemId, item.id))
      .orderBy(s.invoiceItemServiceMaterials.materialVariantId);
    expect(snapshots.map((snapshot) => [
      Number(snapshot.materialVariantId),
      Number(snapshot.baseQuantity),
      snapshot.unitCost,
      snapshot.lineCost,
    ])).toEqual([
      [1, 5, "35.00", "175.00"],
      [2, 5, "20.00", "100.00"],
    ]);
  });

  it("خدمة إلكترونية بلا وصفة ⇒ COGS صفر ولا حركة مخزون", async () => {
    const r = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 11, productUnitId: 11, quantity: "1" }],
      payment: { amount: "5000", method: "CASH" },
    }, actor);
    expect(r.total).toBe("5000.00");
    expect((await invoice(r.invoiceId)).costTotal).toBe("0.00");
    expect(await movements()).toHaveLength(0);
  });

  it("بيع ناتج طباعة مخزني يخصم الناتج بتكلفة WAVG ولا يستهلك الوصفة", async () => {
    const beforePaper = await stock(1);
    const result = await createPrintSale({
      branchId: 1,
      shiftId: 1,
      lines: [{ variantId: 12, productUnitId: 12, quantity: "2" }],
      payment: { amount: "4000", method: "CASH" },
      clientRequestId: "ps-stocked-1",
    }, actor);

    const [invoice] = await db().select().from(s.invoices).where(eq(s.invoices.id, result.invoiceId));
    expect(invoice.costTotal).toBe("2000.00");
    expect(await stock(12)).toBe(8);
    expect(await stock(1)).toBe(beforePaper);

    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
    expect(item.unitCost).toBe("1000.00");

    const moves = await db().select().from(s.inventoryMovements).where(eq(s.inventoryMovements.referenceId, result.invoiceId));
    expect(moves).toHaveLength(1);
    expect(Number(moves[0].variantId)).toBe(12);
    expect(moves[0].movementType).toBe("OUT");
  });

  it("نقص مادة وصفة الخدمة يرفض البيع ذرياً حتى لو كانت المادة موسومة للبيع بالطلب", async () => {
    await db().update(s.products).set({ allowBackorder: true }).where(eq(s.products.id, 2));
    await db().update(s.branchStock).set({ quantity: 5 }).where(sql`${s.branchStock.variantId} = 1 AND ${s.branchStock.branchId} = 1`);
    await db().update(s.branchStock).set({ quantity: 2 }).where(sql`${s.branchStock.variantId} = 2 AND ${s.branchStock.branchId} = 1`);
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }],
      payment: { amount: "1250", method: "CASH" },
    }, actor)).rejects.toThrow(/المخزون غير كاف/);
    // المادة 1 تُعالَج أولاً، ثم تفشل المادة 2؛ رجوع الأولى يثبت ذرّية الحركة لا مجرد فشل مبكر.
    expect(await stock(1)).toBe(5);
    expect(await stock(2)).toBe(2);
    await expectNoSaleArtifacts();
  });

  it("وسم offlineCapture وحده لا يمنح المستدعي الحي صلاحية الرصيد السالب", async () => {
    await db().update(s.products).set({ allowBackorder: true }).where(eq(s.products.id, 2));
    await db().update(s.branchStock).set({ quantity: 0 }).where(eq(s.branchStock.variantId, 2));
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
      offlineCapture: {
        capturedAt: new Date(),
        offlineReceiptNumber: "FORGED-OFFLINE-METADATA",
      },
    }, actor)).rejects.toThrow(/المخزون غير كاف/);
    expect(await stock(2)).toBe(0);
    await expectNoSaleArtifacts();
  });

  it("وصفة خدمة معطلة لا تتحول إلى خدمة عمالية بكلفة صفر", async () => {
    await db().update(s.productionRecipes).set({ isActive: false }).where(eq(s.productionRecipes.id, 1));
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow(/وصفة مواد الخدمة.*معطلة/);
    await expectNoSaleArtifacts();
  });

  it("وصفة خدمة فعالة بلا مواد توقف البيع", async () => {
    await db().delete(s.productionRecipeLines).where(eq(s.productionRecipeLines.recipeId, 1));
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow(/فعالة لكنها بلا مواد/);
    await expectNoSaleArtifacts();
  });

  it("كمية وصفة كسرية لا تُقرّب صامتاً إلى وحدة مخزون", async () => {
    await db().update(s.productionRecipeLines)
      .set({ qtyPerOutputBase: "0.5000" })
      .where(sql`${s.productionRecipeLines.recipeId} = 1 AND ${s.productionRecipeLines.inputVariantId} = 1`);
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow(/كمية كسرية/);
    expect(await stock(1)).toBe(100);
    expect(await stock(2)).toBe(100);
    await expectNoSaleArtifacts();
  });

  it("وصفة كسرية قابلة للتتبع 0.5×2 تخصم وحدة واحدة وتحسب COGS بدقة", async () => {
    await db().update(s.productionRecipeLines)
      .set({ qtyPerOutputBase: "0.5000" })
      .where(sql`${s.productionRecipeLines.recipeId} = 1 AND ${s.productionRecipeLines.inputVariantId} = 1`);
    const result = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "2" }],
      payment: { amount: "500", method: "CASH" },
    }, actor);
    expect((await invoice(result.invoiceId)).costTotal).toBe("75.00");
    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
    expect(item.unitCost).toBe("37.50");
    expect(item.lineCost).toBe("75.00");
    expect(await stock(1)).toBe(99);
    expect(await stock(2)).toBe(98);
    const materialMoves = (await movements()).sort((a, b) => Number(a.variantId) - Number(b.variantId));
    expect(materialMoves.map((move: any) => [Number(move.variantId), Number(move.quantity), move.notes])).toEqual([
      [1, 1, "استهلاك مادة خدمة"],
      [2, 2, "استهلاك مادة خدمة"],
    ]);
  });

  it("lineCost يحفظ كلفة الخدمة الدقيقة حين لا يعيد unitCost المدوّر إنتاجها", async () => {
    await db().delete(s.productionRecipeLines)
      .where(sql`${s.productionRecipeLines.recipeId} = 1 AND ${s.productionRecipeLines.inputVariantId} = 2`);
    await db().update(s.productionRecipeLines)
      .set({ qtyPerOutputBase: "0.5000" })
      .where(sql`${s.productionRecipeLines.recipeId} = 1 AND ${s.productionRecipeLines.inputVariantId} = 1`);
    await db().update(s.productVariants).set({ costPrice: "0.01" }).where(eq(s.productVariants.id, 1));

    const result = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "6" }],
      payment: { amount: "1500", method: "CASH" },
    }, actor);

    const inv = await invoice(result.invoiceId);
    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, result.invoiceId));
    expect(item.unitCost).toBe("0.01");
    expect(item.lineCost).toBe("0.03");
    expect(inv.costTotal).toBe("0.03");
    const [snapshot] = await db().select().from(s.invoiceItemServiceMaterials)
      .where(eq(s.invoiceItemServiceMaterials.invoiceItemId, item.id));
    expect(Number(snapshot.baseQuantity)).toBe(3);
    expect(snapshot.lineCost).toBe("0.03");
    expect(await stock(1)).toBe(97);
  });
});

describe("بيع الطباعة: التقريب النقدي + الذمم + idempotency", () => {
  it("دفع البطاقة بمرجعٍ يُسجَّل إيصالاً خارج درج النقد", async () => {
    const r = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CARD", reference: "POS-CARD-7788" },
    }, actor);
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, r.invoiceId));
    expect(receipt.paymentMethod).toBe("CARD");
    expect(receipt.referenceNumber).toBe("POS-CARD-7788");
    // §٥: غير النقد لا يَمسّ الدرج ⇒ لا دلوَ نقديّ.
    expect(receipt.cashBucket).toBeNull();
  });

  it("دفع غير نقديّ بلا مرجع يُرفض قبل إنشاء فاتورة أو إيصال", async () => {
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CARD" },
    }, actor)).rejects.toThrow();
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });

  it("تقريب IQD للبيع النقدي الكامل ⇒ قيد ADJUST بالفرق", async () => {
    const r = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1", unitPriceOverride: "1240" }],
      payment: { amount: "1250", method: "CASH" },
      cashRoundIQD: true,
    }, actor);
    const inv = await invoice(r.invoiceId);
    expect(inv.total).toBe("1250.00"); // 1240 ⇒ 1250
    expect(inv.paidAmount).toBe("1250.00");
    expect(inv.status).toBe("PAID");
    expect(inv.cashRoundingAdjustment).toBe("10.00");
    const adj = (await entries()).find((e: any) => e.entryType === "ADJUST")!;
    expect(adj.amount).toBe("10.00");
  });

  it("بيع آجل لعميل ⇒ رصيد العميل يرتفع والحالة PENDING", async () => {
    const r = await createPrintSale({
      branchId: 1, shiftId: 1, customerId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }],
    }, actor);
    expect((await invoice(r.invoiceId)).status).toBe("PENDING");
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(c.currentBalance).toBe("1250.00");
  });

  it("تجاوز حدّ الائتمان بلا موافقة مدير ⇒ يُرفض بالحارس الواحد (server/lib/credit.ts)", async () => {
    await expect(createPrintSale({
      branchId: 1, shiftId: 1, customerId: 2, // سقف 1000
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }], // 1250 > 1000
    }, actor)).rejects.toThrow(/تجاوز حدّ الائتمان/);
    // م١ (PR-1): قناة الطباعة لم تعد تفحص الحدّ بنسخةٍ محلّية — الرفضُ هو رفضُ `assertCreditLimit`
    // نفسه بنصّه (نفس العميل، نفس الزيادة) ⇒ لا رسالتان لحكمٍ واحد.
    await expect(withTx((tx) => assertCreditLimit(tx, 2, "1250", 1))).rejects.toThrow(/تجاوز حدّ الائتمان/);
  });

  it("نفس clientRequestId ⇒ فاتورة واحدة (إعادة idempotent)", async () => {
    const key = "req-print-1";
    const a = await createPrintSale({ branchId: 1, shiftId: 1, lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }], payment: { amount: "250", method: "CASH" }, clientRequestId: key }, actor);
    const b = await createPrintSale({ branchId: 1, shiftId: 1, lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }], payment: { amount: "250", method: "CASH" }, clientRequestId: key }, actor);
    expect(b.invoiceId).toBe(a.invoiceId);
    expect(b.idempotentReplay).toBe(true);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });
});

describe("بيع الطباعة: الحراسات", () => {
  it("تعطيل المنتج الأب يمنع بيعه في PrintPOS حتى لو بقي المتغيّر فعالاً", async () => {
    await db().update(s.products).set({ isActive: false }).where(eq(s.products.id, 10));
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow(/معطّلة/);
    await expectNoSaleArtifacts();
  });

  it("حالة تفعيل NULL للمنتج تفشل مغلقاً بعد القفل", async () => {
    await db().update(s.products).set({ isActive: null }).where(eq(s.products.id, 10));
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow(/معطّلة/);
    await expectNoSaleArtifacts();
  });

  it("حالة تفعيل NULL للمتغيّر تفشل مغلقاً بعد قفل المتغيّرات", async () => {
    await db().update(s.productVariants).set({ isActive: null }).where(eq(s.productVariants.id, 10));
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow(/معطّلة/);
    await expectNoSaleArtifacts();
  });

  it("وردية مغلقة ⇒ يُرفض البيع", async () => {
    await db().update(s.shifts).set({ status: "CLOSED" }).where(eq(s.shifts.id, 1));
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow(/الوردية/);
  });

  it("بيع صنف غير خدمة (بضاعة مخزنية) عبر هذا المسار ⇒ يُرفض", async () => {
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], // ورق = مادة لا خدمة
      payment: { amount: "100", method: "CASH" },
    }, actor)).rejects.toThrow(/خدمات الطباعة فقط/);
  });

  it("بيع آجل بلا عميل ⇒ يُرفض", async () => {
    await expect(createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }],
      // بلا payment ⇒ unpaid > 0 بلا عميل
    }, actor)).rejects.toThrow(/عميل/);
  });
});

describe("بيع الطباعة: سلة مختلطة + فئة تسعير", () => {
  it("سلة فيها خدمة بوصفة وأخرى بلا وصفة ⇒ COGS = كلفة مواد الأولى فقط، والمواد تُخصم لها وحدها", async () => {
    const r = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [
        { variantId: 10, productUnitId: 10, quantity: "5" }, // 1250 + مواد (5 ورق + 5 حبر)
        { variantId: 11, productUnitId: 11, quantity: "1" }, // 5000 خدمة إلكترونية بلا مواد
      ],
      payment: { amount: "6250", method: "CASH" },
    }, actor);
    const inv = await invoice(r.invoiceId);
    expect(inv.total).toBe("6250.00");
    expect(inv.costTotal).toBe("275.00"); // 5×35 + 5×20 (الخدمة بلا وصفة لا تضيف كلفة)
    expect(await stock(1)).toBe(95);
    expect(await stock(2)).toBe(95);
  });

  it("السعر اليدوي يُستعمل مهما كانت الفئة ⇒ لا يلزم سعر فئة مُعرَّف للخدمة", async () => {
    const r = await createPrintSale({
      branchId: 1, shiftId: 1, priceTier: "GOVERNMENT", // لا سعر GOVERNMENT مُعرَّف للخدمة
      lines: [{ variantId: 10, productUnitId: 10, quantity: "2", unitPriceOverride: "300" }],
      payment: { amount: "600", method: "CASH" },
    }, actor);
    expect((await invoice(r.invoiceId)).total).toBe("600.00");
  });

  it("بلا سعر يدوي وفئةٌ بلا سعر مُعرَّف ⇒ يُرفض (لا fallback ضمني بين الفئات)", async () => {
    await expect(createPrintSale({
      branchId: 1, shiftId: 1, priceTier: "GOVERNMENT",
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1" }],
      payment: { amount: "250", method: "CASH" },
    }, actor)).rejects.toThrow();
  });
});

describe("بيع الطباعة: فصل درج الطباعة عن التجزئة (قرار المالك ٢٣/٧/٢٦)", () => {
  it("نقد بيع الطباعة يُنسَب لدرج PRINT_SERVICES ولا يظهر في تسوية درج التجزئة", async () => {
    // درجان مفتوحان لنفس الموظّف/الفرع: التجزئة (seed id:1، RETAIL) + الطباعة (id:2، PRINT_SERVICES).
    await db().insert(s.shifts).values({
      id: 2, branchId: 1, userId: 1, openingBalance: "50000", status: "OPEN",
      shiftType: "PRINT_SERVICES", openGuard: "1:1:PRINT_SERVICES",
    });

    // بيع طباعة نقديّ على درج الطباعة صراحةً (كما يمرّره PrintPOS بعد الفصل).
    const r = await createPrintSale({
      branchId: 1, shiftId: 2,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }],
      payment: { amount: "1250", method: "CASH" },
    }, actor);

    // الإيصال منسوبٌ لدرج الطباعة (id:2) لا التجزئة (id:1).
    const rec = (await db().select().from(s.receipts))[0];
    expect(Number(rec.shiftId)).toBe(2);
    expect(rec.cashBucket).toBe("DRAWER");

    // Z-report درج الطباعة يعكس البيع؛ درج التجزئة يبقى نظيفاً (عزلٌ نقديّ فعليّ).
    const printReport = await getShiftReport(2);
    expect(printReport?.invoiceCount).toBe(1);
    expect(printReport?.salesTotal).toBe("1250.00");
    expect(printReport?.payments.some((p: any) => p.method === "CASH" && p.direction === "IN" && p.total === "1250.00")).toBe(true);
    expect(printReport?.expectedCash).toBe("51250.00");

    // سجلّ CASH غير تابع للدرج (TREASURY) يحمل shiftId بالخطأ/من بيانات قديمة: يظهر في التفصيل العام
    // لكنه لا يجوز أن يغيّر رقم العدّ الذي سيفرضه closeShift (DRAWER حصراً).
    await db().insert(s.receipts).values({
      branchId: 1, shiftId: 2, direction: "IN", amount: "999.00", paymentMethod: "CASH",
      cashBucket: "TREASURY", status: "COMPLETED", createdBy: 1,
    });
    expect((await getShiftReport(2))?.expectedCash).toBe("51250.00");

    const retailReport = await getShiftReport(1);
    expect(retailReport?.invoiceCount).toBe(0);
    expect(retailReport?.salesTotal).toBe("0.00");
    expect(retailReport?.payments.length).toBe(0);
  });
});
