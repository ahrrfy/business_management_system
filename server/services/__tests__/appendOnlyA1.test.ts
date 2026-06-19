/**
 * A1 (١٩/٦/٢٦) — لقد كان workOrderService.deliverWorkOrder يُحدِّث accountingEntries.invoiceId
 * على قيد PAYMENT_IN للعربون عند التسليم ⇒ انتهاك append-only.
 *
 * الإصلاح: أُزيلت الـUPDATE. القيد يبقى invoiceId=NULL مدى الحياة. الـreceipt.workOrderId يبقى
 * الحارس البنيوي الذي يستثني العربون من voucherSum في reconcileService.
 *
 * هذا الاختبار يثبت:
 *  ١) قيد PAYMENT_IN للعربون يبقى invoiceId=NULL بعد التسليم.
 *  ٢) ميزانية العميل تتوازن (لا double-count من العربون).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createWorkOrder, deliverWorkOrder, markWorkOrderReady, startWorkOrder } from "../workOrderService";
import { reconcileCustomerBalances } from "../reconcileService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "admin" };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }
const getInsertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() {
  await truncateTables([
    "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
    "workOrderMaterials", "workOrderItems", "workOrderImages", "workOrders",
    "branchStock", "productPrices", "productUnits", "productVariants", "products",
    "shifts", "customers", "branches", "users",
  ]);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "خدمة طباعة" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "SVC-1", costPrice: "0" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.customers).values({ id: 1, name: "عميل WO", defaultPriceTier: "RETAIL" });
  // وردية مفتوحة للعربون النقدي
  const sr = await d.insert(s.shifts).values({
    userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(),
    openGuard: "1:1", openingBalance: "0",
  });
  return { shiftId: getInsertId(sr) };
}

beforeEach(reset);

describe("A1: append-only — workOrderService لا يُحدِّث accountingEntries", () => {
  it("عند التسليم: قيد PAYMENT_IN للعربون يبقى invoiceId=NULL + AR متوازن", async () => {
    await seedBase();
    // 1. أنشئ أمر شغل بعربون 50 (نقدي)
    const wo = await createWorkOrder({
      branchId: 1,
      customerId: 1,
      baseVariantId: 1,
      title: "كتابة عرض",
      quantity: 1,
      salePrice: "200.00",
      deposit: "50.00",
      paymentMethod: "CASH",
    }, actor);
    expect(wo.workOrderId).toBeGreaterThan(0);

    // 2. سيرورة كاملة: START → READY → DELIVER
    await startWorkOrder(wo.workOrderId, actor);
    await markWorkOrderReady(wo.workOrderId, actor);
    const d = await deliverWorkOrder({ workOrderId: wo.workOrderId, payment: { amount: "100.00", method: "CASH" } }, actor);

    // 3. قيد PAYMENT_IN للعربون يجب أن يبقى invoiceId = NULL (append-only)
    const dbi = db();
    const paymentEntries = await dbi
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));

    // ينبغي وجود قيدَين PAYMENT_IN: عربون + دفعة تسليم
    expect(paymentEntries.length).toBeGreaterThanOrEqual(2);
    // قيد العربون: receiptId مُسجَّل، invoiceId يبقى NULL (لا يُحدَّث)
    const depositEntries = paymentEntries.filter((e) => e.amount === "50.00");
    expect(depositEntries.length).toBe(1);
    expect(depositEntries[0].invoiceId).toBeNull();

    // 4. reconcileService — لا انحراف (لا double-count من العربون).
    //    salePrice=200، paidAmount=50(عربون)+100(تسليم)=150 ⇒ AR=50
    //    الـreconcile يرجع issues فقط؛ مصفوفة فارغة = توازن تام.
    const issues = await reconcileCustomerBalances();
    const customerIssue = issues.find((i) => i.id === 1);
    expect(customerIssue).toBeUndefined(); // لا انحراف
  });
});
