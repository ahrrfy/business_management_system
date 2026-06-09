import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeInvoiceTotals } from "../billing";
import { reconcileCustomerBalances } from "../reconcileService";
import { returnSale } from "../returnService";
import { createSale, processPayment } from "../saleService";
import { closeShift } from "../shiftService";
import { createWorkOrder, deliverWorkOrder, markWorkOrderReady, startWorkOrder } from "../workOrderService";

const actor = { userId: 1, branchId: 1, role: "admin" };
const cashierA = { userId: 2, branchId: 1, role: "cashier" };
const cashierB = { userId: 3, branchId: 2, role: "cashier" };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "cashierA", name: "أ", role: "cashier", branchId: 1, loginMethod: "local" },
    { id: 3, openId: "cashierB", name: "ب", role: "cashier", branchId: 2, loginMethod: "local" },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function openShift(branchId = 1, userId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("billing — خصم الفاتورة مُقرّب مرة واحدة (لا انجراف 0.01)", () => {
  it("computeInvoiceTotals: total = subtotal − discountAmount + taxAmount بالضبط", () => {
    const t = computeInvoiceTotals({ lineTotals: ["100.00"], invoiceDiscount: "10.125" });
    // قبل الإصلاح: discountAmount=10.13 و total=89.88 لكن subtotal-discount=89.87.
    const sub = Number(t.subtotal);
    const disc = Number(t.discountAmount);
    const tax = Number(t.taxAmount);
    const tot = Number(t.total);
    expect(Math.abs(tot - (sub - disc + tax))).toBeLessThan(0.005);
  });
});

describe("closeShift — تدقيق الملكية/الفرع (IDOR)", () => {
  it("يرفض كاشير إغلاق وردية كاشير آخر", async () => {
    const shA = await openShift(1, 2); // وردية الكاشير A في الفرع 1
    await expect(closeShift({ shiftId: shA, countedCash: "0" }, cashierB)).rejects.toThrow();
    // الكاشير A يستطيع
    const r = await closeShift({ shiftId: shA, countedCash: "0" }, cashierA);
    expect(r.shiftId).toBe(shA);
  });

  it("admin يستطيع إغلاق أي وردية", async () => {
    const sh = await openShift(1, 2);
    const r = await closeShift({ shiftId: sh, countedCash: "0" }, actor);
    expect(r.shiftId).toBe(sh);
  });
});

describe("reconcileCustomerBalances — لا انحراف وهمي بعد مرتجع جزئي/دفع زائد", () => {
  it("مرتجع جزئي على فاتورة آجلة لا يُنتج انحرافاً وهمياً", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }] },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    // إرجاع نصف الكمية بلا استرداد نقدي (مرتجع جزئي على آجل).
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 5 }] }, actor);
    // قبل الإصلاح: expectedBalance يستخدم total كاملاً ⇒ انحراف 50.
    const issues = await reconcileCustomerBalances();
    expect(issues).toHaveLength(0);
  });

  it("دفع زائد لا يُنتج انحرافاً وهمياً", async () => {
    await setStock(1, 1, 10);
    await db().insert(s.customers).values({ id: 1, name: "ت", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }] },
      actor,
    );
    // ادفع أكثر من المستحق (30 على 30 ثم 20 إضافية)
    await processPayment({ invoiceId: sale.invoiceId, amount: "50.00", method: "CASH" }, actor);
    const issues = await reconcileCustomerBalances();
    expect(issues).toHaveLength(0);
  });
});

describe("WORKORDER — إرجاع لا يُعيد المتغيّر الأساس إلى المخزون (لا مخزون وهمي)", () => {
  it("returnSale على فاتورة WORKORDER يَفرض restock=false", async () => {
    await setStock(1, 1, 5); // مواد كافية للبدء (نستخدم variantId 1 كمواد + كأساس للتبسيط)
    const wo = await createWorkOrder(
      { branchId: 1, baseVariantId: 1, title: "درع", salePrice: "100.00", materials: [{ variantId: 1, baseQuantity: 1 }] },
      actor,
    );
    await startWorkOrder(wo.workOrderId, actor);
    await markWorkOrderReady(wo.workOrderId, actor);
    const deliver = await deliverWorkOrder({ workOrderId: wo.workOrderId, payment: { amount: "100.00", method: "CASH" } }, actor);

    const stockBefore = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity;
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, deliver.invoiceId)))[0];
    await returnSale({ invoiceId: deliver.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], refund: { amount: "100.00", method: "CASH" } }, actor);
    const stockAfter = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity;
    expect(stockAfter).toBe(stockBefore); // لا تغيير — لم يُعَد المنتج الأساس وهمياً
  });
});
