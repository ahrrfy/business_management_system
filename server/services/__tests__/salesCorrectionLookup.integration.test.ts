import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { lookupInvoiceForCorrection } from "../sale/correctionLookup";
import { truncateTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await truncateTables([
    "auditLogs", "salesControlRequests", "digitalSaleDetails", "installmentPlans",
    "deliveryConsignments", "onlineOrders", "receipts", "invoiceItems", "invoices",
    "branchStock", "productPrices", "productUnits", "productVariants", "products",
    "shifts", "users", "branches",
  ]);
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع ثان", code: "BR2", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "lookup-u1", name: "موظف الاستقبال", role: "print_operator", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "lookup-u2", name: "زميل الفرع", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "lookup-m1", name: "مدير الفرع", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "lookup-u4", name: "موظف فرع ثان", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await db().insert(s.shifts).values([
    { id: 1, userId: 1, branchId: 1, shiftType: "RECEPTION", status: "OPEN", openingBalance: "0" },
    { id: 2, userId: 1, branchId: 1, shiftType: "RETAIL", status: "OPEN", openingBalance: "0" },
    { id: 3, userId: 2, branchId: 1, shiftType: "RECEPTION", status: "OPEN", openingBalance: "0" },
    { id: 4, userId: 4, branchId: 2, shiftType: "RECEPTION", status: "OPEN", openingBalance: "0" },
  ]);
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "LOOKUP-1", costPrice: "60.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.invoices).values([
    { id: 101, invoiceNumber: "101", offlineReceiptNumber: "OFF-101", sourceType: "POS", branchId: 1, shiftId: 1, subtotal: "100.00", total: "100.00", paidAmount: "100.00", status: "PAID", createdBy: 1 },
    { id: 102, invoiceNumber: "102", sourceType: "POS", branchId: 1, shiftId: 2, subtotal: "100.00", total: "100.00", paidAmount: "100.00", status: "PAID", createdBy: 1 },
    { id: 103, invoiceNumber: "103", sourceType: "POS", branchId: 1, shiftId: 3, subtotal: "100.00", total: "100.00", paidAmount: "100.00", status: "PAID", createdBy: 2 },
    { id: 104, invoiceNumber: "104", sourceType: "POS", branchId: 2, shiftId: 4, subtotal: "100.00", total: "100.00", paidAmount: "100.00", status: "PAID", createdBy: 4 },
  ]);
  await db().insert(s.invoiceItems).values([101, 102, 103, 104].map((invoiceId) => ({
    invoiceId,
    variantId: 1,
    productUnitId: 1,
    quantity: "1",
    baseQuantity: 1,
    unitPrice: "100.00",
    total: "100.00",
  })));
});

describe("lookupInvoiceForCorrection — عزل المسح التشغيلي", () => {
  it("يقصر الاستقبال على فاتورته وقناته ويتيح للمدير فرعه فقط", async () => {
    const reception = { userId: 1, branchId: 1, role: "print_operator", scopedOwnerId: 1, invoiceScope: "reception" as const };
    expect(await lookupInvoiceForCorrection(" INV-101 ", reception)).toMatchObject({ id: 101, canCorrect: true });
    expect(await lookupInvoiceForCorrection("OFF-101", reception)).toMatchObject({ id: 101 });
    expect(await lookupInvoiceForCorrection("102", reception)).toBeNull();
    expect(await lookupInvoiceForCorrection("103", reception)).toBeNull();

    const manager = { userId: 3, branchId: 1, role: "manager", scopedOwnerId: null, invoiceScope: "sales" as const };
    expect(await lookupInvoiceForCorrection("102", manager)).toMatchObject({ id: 102 });
    expect(await lookupInvoiceForCorrection("103", manager)).toMatchObject({ id: 103 });
    expect(await lookupInvoiceForCorrection("104", manager)).toBeNull();
  });
});
