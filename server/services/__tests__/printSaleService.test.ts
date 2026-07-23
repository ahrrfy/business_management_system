// اختبارات بيع خدمات الطباعة (printSaleService): الإيراد + COGS من الوصفة، خصم المواد بصمت،
// allowNegative (لا تُرفَض الخدمة عند نفاد المادة)، التقريب النقدي IQD، الذمم/الائتمان،
// idempotency، فحص الوردية، وحارس «خدمات فقط». تطابق ثوابت المحرّك المالي المُدقّق.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPrintSale } from "../printSaleService";
import { getShiftReport } from "../shiftService";
import { withTx } from "../tx";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

const TABLES = [
  "accountingEntries", "receipts", "invoiceItems", "invoices",
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
    { id: 1, name: "عميل آجل", defaultPriceTier: "RETAIL", creditLimit: "0", currentBalance: "0" },
    { id: 2, name: "عميل بسقف", defaultPriceTier: "RETAIL", creditLimit: "1000", currentBalance: "0" },
  ]);
  // منتجات: مادتان مخزنيتان (ورق/حبر) + خدمتان (PRINT_SERVICE).
  await d.insert(s.products).values([
    { id: 1, name: "ورق A4" },
    { id: 2, name: "حبر أسود" },
    { id: 10, name: "تصوير A4 أبيض/أسود", productType: "PRINT_SERVICE" },
    { id: 11, name: "تقديم استمارة إلكترونية", productType: "PRINT_SERVICE" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "MAT-A4", costPrice: "35.00" },
    { id: 2, productId: 2, sku: "MAT-INK", costPrice: "20.00" },
    { id: 10, productId: 10, sku: "SVC-COPY", costPrice: "0.00" },
    { id: 11, productId: 11, sku: "SVC-ESERV", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "وحدة", conversionFactor: "1", isBaseUnit: true },
    { id: 10, variantId: 10, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true },
    { id: 11, variantId: 11, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 10, priceTier: "RETAIL", price: "250.00" },
    { productUnitId: 11, priceTier: "RETAIL", price: "5000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
  ]);
  // وصفة الخدمة 10: ورقة + حبر لكل وحدة خدمة.
  await d.insert(s.productionRecipes).values({ id: 1, name: "[طباعة] تصوير A4 ب/أ", outputVariantId: 10, outputProductUnitId: 10, laborPerOutputBase: "0", wasteStdPct: "0", isActive: true });
  await d.insert(s.productionRecipeLines).values([
    { recipeId: 1, inputVariantId: 1, qtyPerOutputBase: "1.0000" },
    { recipeId: 1, inputVariantId: 2, qtyPerOutputBase: "1.0000" },
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

describe("بيع الطباعة: الإيراد + كلفة المواد + خصم المخزون", () => {
  it("بيع نقدي كامل يخصم المواد ويُحتسب COGS من الوصفة", async () => {
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
    expect(await stock(1)).toBe(95);
    expect(await stock(2)).toBe(95);
    expect(await stock(10)).toBeNull();
    // قيد البيع: revenue 1250، cost 275، profit 975 + PAYMENT_IN.
    const es = await entries();
    const sale = es.find((e: any) => e.entryType === "SALE")!;
    expect(sale.revenue).toBe("1250.00");
    expect(sale.cost).toBe("275.00");
    expect(sale.profit).toBe("975.00");
    expect(es.some((e: any) => e.entryType === "PAYMENT_IN" && e.amount === "1250.00")).toBe(true);
    // إيصال منسوب للوردية (تسوية الصندوق).
    const rec = (await db().select().from(s.receipts))[0];
    expect(Number(rec.shiftId)).toBe(1);
    // كلفة وحدة السطر = 275 / 5.
    const item = (await db().select().from(s.invoiceItems))[0];
    expect(item.unitCost).toBe("55.00");
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

  it("الخدمة لا تُرفَض عند نفاد المادة (allowNegative) لكن الاستهلاك يُتعقَّب", async () => {
    await db().update(s.branchStock).set({ quantity: 2 }).where(sql`${s.branchStock.variantId} = 1 AND ${s.branchStock.branchId} = 1`);
    const r = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }],
      payment: { amount: "1250", method: "CASH" },
    }, actor);
    expect(r.invoiceId).toBeGreaterThan(0);
    expect(await stock(1)).toBe(-3); // 2 − 5: رصيد سالب = إشارة تزويد، الاستهلاك مُسجَّل بالكامل
    const move = (await movements()).find((m: any) => Number(m.variantId) === 1)!;
    expect(Number(move.quantity)).toBe(5);
    expect(move.movementType).toBe("OUT");
  });
});

describe("بيع الطباعة: التقريب النقدي + الذمم + idempotency", () => {
  it("تقريب IQD للبيع النقدي الكامل ⇒ قيد ADJUST بالفرق", async () => {
    const r = await createPrintSale({
      branchId: 1, shiftId: 1,
      lines: [{ variantId: 10, productUnitId: 10, quantity: "1", unitPriceOverride: "1240" }],
      payment: { amount: "1240", method: "CASH" },
      cashRoundIQD: true,
    }, actor);
    const inv = await invoice(r.invoiceId);
    expect(inv.total).toBe("1250.00"); // 1240 ⇒ 1250
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

  it("تجاوز حدّ الائتمان بلا موافقة مدير ⇒ يُرفض", async () => {
    await expect(createPrintSale({
      branchId: 1, shiftId: 1, customerId: 2, // سقف 1000
      lines: [{ variantId: 10, productUnitId: 10, quantity: "5" }], // 1250 > 1000
    }, actor)).rejects.toThrow(/الائتمان/);
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

    const retailReport = await getShiftReport(1);
    expect(retailReport?.invoiceCount).toBe(0);
    expect(retailReport?.salesTotal).toBe("0.00");
    expect(retailReport?.payments.length).toBe(0);
  });
});
