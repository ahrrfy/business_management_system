// بيع مباشر آجل في الاستقبال (قرار المالك ١٠/٨) — متابعة الفجوة: يسمح بأن يقلّ المقبوض عن إجمالي
// البضاعة الجاهزة **بلا توصيل** حين يوجد عميلٌ مسجَّل والعلَم `deferredDirect` مرفوع؛ المتبقّي يصير
// ذمّةً على العميل (AR) عبر createSaleInTx، وحدّ الائتمان نافذٌ فيها. بلا علَمٍ أو بلا عميلٍ يبقى
// حاجز «المقبوض يغطّي البيع المباشر» صارماً (لا ذمّةٌ بلا صاحب، ولا ذمّةٌ صامتةٌ من إدخالٍ خاطئ).
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const TABLES = [
  "orderPayments", "auditLogs", "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
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
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل موثوق", currentBalance: "0.00", creditLimit: "1000000.00" },
    { id: 2, name: "عميل محدود", currentBalance: "0.00", creditLimit: "5000.00" },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}
const openReception = () => openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
const LINE = { variantId: 1, productUnitId: 1, quantity: "10" }; // ١٠ × ١٠٠٠ = ١٠٬٠٠٠

async function balance(customerId: number): Promise<number> {
  return Number((await db().select().from(s.customers).where(eq(s.customers.id, customerId)))[0].currentBalance);
}
async function invoiceOf(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("بيع مباشر آجل في الاستقبال — deferredDirect", () => {
  it("بلا العلَم: المقبوض 0 على بضاعة جاهزة بلا توصيل ⇒ يُرفض (الحاجز الأصليّ)", async () => {
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0", clientRequestId: "no-flag",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER)).rejects.toThrowError(/يغطي البيع المباشر/);
    expect(await balance(1)).toBe(0); // ذرّية — لا ذمّة
    expect((await db().select().from(s.invoices)).length).toBe(0);
  });

  it("بالعلَم + عميل موثوق + مقبوض 0 ⇒ بيعٌ آجل، الإجمالي كلّه ذمّة على العميل", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "def-full",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    expect(r.regularSale).toBeTruthy();
    const inv = await invoiceOf(r.regularSale!.invoiceId);
    expect(inv.total).toBe("10000.00");
    expect(inv.paidAmount).toBe("0.00"); // لا نقد وهميّ
    expect(await balance(1)).toBe(10000); // كامل الدَّين ذمّة (رُخّي الحاجز لا التسجيل)
  });

  it("بالعلَم + دفعة جزئية ⇒ المدفوع نقدٌ فعليّ والباقي ذمّة", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "4000", deferredDirect: true, clientRequestId: "def-part",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    const inv = await invoiceOf(r.regularSale!.invoiceId);
    expect(inv.paidAmount).toBe("4000.00");
    expect(await balance(1)).toBe(6000); // 10000 − 4000
  });

  it("بالعلَم لكن بلا عميلٍ مسجَّل (عابر) ⇒ يبقى الحاجز صارماً — لا ذمّة بلا صاحب", async () => {
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: null, contactName: "زبون عابر",
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "def-nocust",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER)).rejects.toThrowError(/يغطي البيع المباشر/);
  });

  it("بالعلَم + عميلٌ يتجاوز حدّ ائتمانه ⇒ FORBIDDEN (الحدّ نافذٌ ذرّياً)", async () => {
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 2, // حدّه 5000 < 10000
      paymentMethod: "CASH", paidAmount: "0", deferredDirect: true, clientRequestId: "def-over",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER)).rejects.toThrowError(/تجاوز حدّ الائتمان/);
    expect(await balance(2)).toBe(0); // ذرّية — لا ذمّة عند الرفض
    expect((await db().select().from(s.invoices)).length).toBe(0);
  });
});
