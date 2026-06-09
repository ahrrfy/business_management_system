/**
 * اختبارات السياسات المالية — تدقيق ٨/٦ #14.
 * تغطّي ست سياسات:
 *   ١) رفض الضريبة السالبة
 *   ٢) رفض السعر السالب (unitPriceOverride)
 *   ٣) رفض الخصم السالب (سطر/رأس فاتورة)
 *   ٤) closeShift فحص ملكية/فرع
 *   ٥) لا مسار حذف لـreceipts/returns ⇒ النقد لا يبقى بلا مقابل
 *   ٦) الدفع الزائد مسموح (قرار مالك §٦) — يُضبط بالاختبار كي لا ينقلب الحكم سهواً
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeInvoiceTotals, computeLineTotal } from "../billing";
import { money } from "../money";
import { createSale, processPayment } from "../saleService";
import { closeShift } from "../shiftService";

const TABLES = [
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
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "u1", name: "cashier1", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "u2", name: "cashier2", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "u3", name: "manager1", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "u4", name: "admin1", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}
async function openShiftRow(branchId = 1, userId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

// ─── ١) ضريبة سالبة ──────────────────────────────────────────────────
describe("السياسة ١: رفض الضريبة السالبة", () => {
  it("computeInvoiceTotals يرفض taxRatePercent سالب", () => {
    expect(() => computeInvoiceTotals({ lineTotals: ["100"], taxRatePercent: "-5" }))
      .toThrowError(/نسبة الضريبة لا يصحّ أن تكون سالبة/);
  });
  it("createSale يرفض ضريبة سالبة على رأس الفاتورة", async () => {
    await setStock(1, 1, 10);
    await expect(
      createSale(
        { branchId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], taxRatePercent: "-10", payment: { amount: "0", method: "CASH" } },
        { userId: 1, branchId: 1 },
      ),
    ).rejects.toThrow(/نسبة الضريبة لا يصحّ أن تكون سالبة/);
  });
});

// ─── ٢) سعر سالب ─────────────────────────────────────────────────────
describe("السياسة ٢: رفض السعر السالب", () => {
  it("computeLineTotal يرفض unitPrice سالب", () => {
    expect(() => computeLineTotal({ unitPrice: money("-1"), quantity: money("1") }))
      .toThrowError(/السعر لا يصحّ أن يكون سالباً/);
  });
  it("createSale يرفض unitPriceOverride سالب (بضاعة مجانية بخصم زائف)", async () => {
    await setStock(1, 1, 10);
    await expect(
      createSale(
        { branchId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "-5" }] },
        { userId: 1, branchId: 1 },
      ),
    ).rejects.toThrow(/السعر لا يصحّ أن يكون سالباً/);
  });
  it("السعر صفر مسموح (هدية ترويجية: total=0)", () => {
    const r = computeLineTotal({ unitPrice: money("0"), quantity: money("1") });
    expect(r.total).toBe("0.00");
  });
});

// ─── ٣) خصم سالب ─────────────────────────────────────────────────────
describe("السياسة ٣: رفض الخصم السالب + تقريب invoiceDiscount", () => {
  it("computeLineTotal يرفض discountAmount سالب", () => {
    expect(() => computeLineTotal({ unitPrice: money("10"), quantity: money("1"), discountAmount: "-2" }))
      .toThrowError(/الخصم لا يصحّ أن يكون سالباً/);
  });
  it("computeLineTotal يرفض discountPercent سالب", () => {
    expect(() => computeLineTotal({ unitPrice: money("10"), quantity: money("1"), discountPercent: "-10" }))
      .toThrowError(/نسبة الخصم لا يصحّ أن تكون سالبة/);
  });
  it("computeInvoiceTotals يرفض invoiceDiscount سالب", () => {
    expect(() => computeInvoiceTotals({ lineTotals: ["100"], invoiceDiscount: "-5" }))
      .toThrowError(/خصم الفاتورة لا يصحّ أن يكون سالباً/);
  });
  it("invoiceDiscount غير مقرَّب يُقرَّب إلى رقمين قبل الاستخدام (متطابق محاسبياً)", () => {
    const r = computeInvoiceTotals({ lineTotals: ["100.00"], invoiceDiscount: "9.999", taxRatePercent: "0" });
    // 9.999 ⇒ round2 ⇒ 10.00
    expect(r.discountAmount).toBe("10.00");
    expect(r.total).toBe("90.00");
  });
});

// ─── ٤) closeShift ملكية/فرع ─────────────────────────────────────────
describe("السياسة ٤: closeShift فحص ملكية/فرع", () => {
  it("الكاشير يُغلق ورديته نفسها", async () => {
    const shiftId = await openShiftRow(1, 1);
    const r = await closeShift({ shiftId, countedCash: "0" }, { userId: 1, branchId: 1, role: "cashier" });
    expect(r.shiftId).toBe(shiftId);
  });
  it("الكاشير يُرفض إغلاق وردية موظّف آخر", async () => {
    const shiftId = await openShiftRow(1, 2);
    await expect(
      closeShift({ shiftId, countedCash: "0" }, { userId: 1, branchId: 1, role: "cashier" }),
    ).rejects.toThrow(/وردية موظّف آخر/);
  });
  it("الكاشير يُرفض إغلاق وردية فرع آخر حتى لو كانت ورديته", async () => {
    const shiftId = await openShiftRow(2, 1);
    await expect(
      closeShift({ shiftId, countedCash: "0" }, { userId: 1, branchId: 1, role: "cashier" }),
    ).rejects.toThrow(/فرع آخر/);
  });
  it("المدير يُغلق وردية أي كاشير في فرعه (للوردية المنسيّة)", async () => {
    const shiftId = await openShiftRow(1, 2);
    const r = await closeShift({ shiftId, countedCash: "0" }, { userId: 3, branchId: 1, role: "manager" });
    expect(r.shiftId).toBe(shiftId);
  });
  it("المدير يُرفض إغلاق وردية فرع آخر", async () => {
    const shiftId = await openShiftRow(2, 2);
    await expect(
      closeShift({ shiftId, countedCash: "0" }, { userId: 3, branchId: 1, role: "manager" }),
    ).rejects.toThrow(/فرع آخر/);
  });
  it("admin يُغلق أي وردية في أي فرع", async () => {
    const shiftId = await openShiftRow(2, 2);
    const r = await closeShift({ shiftId, countedCash: "0" }, { userId: 4, branchId: 1, role: "admin" });
    expect(r.shiftId).toBe(shiftId);
  });
});

// ─── ٥) لا حذف لـreceipts/returns ─────────────────────────────────────
describe("السياسة ٥: استرداد لا يُحذف يدوياً (الحماية البنيوية)", () => {
  it("لا توجد دالة void/cancel للمرتجع تُفرّغ النقد بلا قيد مقابل", async () => {
    // البنية الحالية: returnSale يولّد receipt OUT + قيد RETURN معاً، ولا توجد دالة عكسية.
    // أي محاولة لاحقة لإضافة void يجب أن تولّد receipt IN مقابل (هذا الاختبار يثبّت السلوك).
    const svcModule = await import("../returnService");
    expect((svcModule as any).cancelReturn).toBeUndefined();
    expect((svcModule as any).voidReturn).toBeUndefined();
    expect((svcModule as any).deleteReturn).toBeUndefined();
  });
});

// ─── ٦) الدفع الزائد مسموح (قرار مالك §٦) ────────────────────────────
describe("السياسة ٦: الدفع الزائد مسموح ويُسجَّل AR سالباً (قرار مالك)", () => {
  it("دفع أعلى من إجمالي الفاتورة يُقبَل، الحالة PAID والـcustomerBalance سالب (دائن للعميل)", async () => {
    await setStock(1, 1, 10);
    const cust = await db().insert(s.customers).values({ name: "علي", customerType: "فرد", defaultPriceTier: "RETAIL" });
    const customerId = insertId(cust);
    // بيع آجل ١٠ على عميل.
    const sale = await createSale(
      { branchId: 1, sourceType: "POS", customerId, lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] },
      { userId: 1, branchId: 1 },
    );
    expect(sale.status).toBe("PENDING");
    // دفع ١٥ (زائد ٥): النظام يقبل (قرار مالك "مسموح").
    const pay = await processPayment({ invoiceId: sale.invoiceId, amount: "15.00", method: "CASH" }, { userId: 1, branchId: 1 });
    expect(pay.status).toBe("PAID");
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, customerId)))[0];
    // AR سالب = الشركة مدينة للعميل بـ٥.
    expect(money(c.currentBalance).toFixed(2)).toBe("-5.00");
  });
});
