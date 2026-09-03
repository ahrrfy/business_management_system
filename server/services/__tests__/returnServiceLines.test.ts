/**
 * أصناف الخدمة في المرتجع والتصحيح (١٨/٨).
 *
 * عيبان كان يسبّبهما موضعٌ واحد: `returnSaleInTx` لم يكن يفرّق الخدمة عن السلعة، فيكتب لها
 * حركة RETRUN ورصيداً في `branchStock` **من العدم**:
 *  ① مخزونٌ وهميّ يتضخّم مع كل مرتجع فاتورة طباعة (ويسمّم WAVG وتقارير المخزون).
 *  ② ولأجله وُضع في `correctSale` حارسٌ يرفض تصحيح أيّ فاتورةٍ فيها سطر خدمة — فخرجت
 *    **فواتير خدمات الطباعة** (نصف سلّة الاستقبال) من التصحيح كلّياً، رغم أنّ الواجهة تُعلن
 *    حاجز WORKORDER وحده (بلاغ المالك: «شاشة التصحيح بدائية ولا تعمل»).
 * العلاج في الجذر: العكس للخدمة ماليٌّ بحت — فرُفع الحارس.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";

const manager = { userId: 1, branchId: 1, role: "manager" };
const cashier = { userId: 2, branchId: 1 };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

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
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مديرة", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "csh", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  // صنف خدمة (طباعة) وصنف سلعة — لإثبات أنّ العلاج انتقائيّ لا شامل.
  await d.insert(s.products).values([
    { id: 1, name: "طباعة ملوّنة", isService: true },
    { id: 2, name: "دفتر", isService: false },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SRV-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "400.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "صفحة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "250.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
  ]);
  // الخدمة بلا رصيد افتتاحيّ إطلاقاً — لا صفّ `branchStock` لها (هذا هو بيت القصيد).
  await d.insert(s.branchStock).values({ variantId: 2, branchId: 1, quantity: 100 });
}
async function openShiftFor(userId: number) {
  const r = await db().insert(s.shifts).values({ branchId: 1, userId, openingBalance: "0", status: "OPEN" });
  return Number((r as unknown as { insertId: number }).insertId ?? (r as unknown as [{ insertId: number }])[0]?.insertId);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("مرتجع فاتورة خدمة — عكسٌ ماليّ بلا مخزون وهميّ", () => {
  it("⭐ إرجاع سطر خدمة: يعكس الإيراد ولا يكتب حركة مخزون ولا رصيداً للخدمة", async () => {
    const shiftId = await openShiftFor(2);
    const sale = await createSale({
      branchId: 1, shiftId, sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }], // 2,500 خدمة
      payment: { amount: "2500.00", method: "CASH" },
    }, cashier);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];

    await returnSale({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 10 }],
      resolution: {
        kind: "IMMEDIATE_REFUND", method: "CASH", amount: "2500.00", shiftId,
        reason: "مرتجع خدمة كامل بلا إنشاء مخزون وهمي", disposition: "RESTOCK",
      }, // حتى مع قرار الإرجاع للمخزون: الخدمة لا رصيد لها
    }, manager);

    // الأثر الماليّ وقع كاملاً.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).toBe("RETURNED");
    expect(inv.returnedTotal).toBe("2500.00");

    // ولا أثر مخزنيّ إطلاقاً — لا حركة ولا صفّ رصيد للخدمة.
    const movements = await db().select().from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.variantId, 1), eq(s.inventoryMovements.movementType, "RETURN")));
    expect(movements).toHaveLength(0);
    const stock = await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1));
    expect(stock).toHaveLength(0); // لم يُخلَق رصيدٌ من العدم
  });

  it("السلعة العادية تبقى تعود للمخزون (العلاج انتقائيّ لا شامل)", async () => {
    const shiftId = await openShiftFor(2);
    const sale = await createSale({
      branchId: 1, shiftId, sourceType: "POS",
      lines: [{ variantId: 2, productUnitId: 2, quantity: "5" }],
      payment: { amount: "5000.00", method: "CASH" },
    }, cashier);
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    expect(Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 2)))[0].quantity)).toBe(95);

    await returnSale({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 5 }],
      resolution: {
        kind: "IMMEDIATE_REFUND", method: "CASH", amount: "5000.00", shiftId,
        reason: "مرتجع سلعة كاملة قابلة للعودة إلى المخزون", disposition: "RESTOCK",
      },
    }, manager);

    expect(Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 2)))[0].quantity)).toBe(100);
  });

  it("فاتورة مختلطة (خدمة + سلعة): السلعة وحدها تعود للرفّ", async () => {
    const shiftId = await openShiftFor(2);
    const sale = await createSale({
      branchId: 1, shiftId, sourceType: "POS",
      lines: [
        { variantId: 1, productUnitId: 1, quantity: "4" },
        { variantId: 2, productUnitId: 2, quantity: "3" },
      ],
      payment: { amount: "4000.00", method: "CASH" },
    }, cashier);
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));

    await returnSale({
      invoiceId: sale.invoiceId,
      lines: items.map((it) => ({ invoiceItemId: Number(it.id), baseQuantity: Number(it.baseQuantity) })),
      resolution: {
        kind: "IMMEDIATE_REFUND", method: "CASH", amount: "4000.00", shiftId,
        reason: "مرتجع فاتورة مختلطة يعيد السلعة المملوكة فقط", disposition: "RESTOCK",
      },
    }, manager);

    expect(Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 2)))[0].quantity)).toBe(100);
    expect(await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1))).toHaveLength(0);
  });
});
