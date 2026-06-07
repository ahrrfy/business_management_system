import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits", "productVariants", "products", "customers", "branches", "users"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed(creditLimit: string, balance = "0") {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "100.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", creditLimit, currentBalance: balance });
}
beforeEach(reset);

const creditSale = (extra: Record<string, unknown> = {}) =>
  createSale({ branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], ...extra }, actor); // 2×100 = 200 آجل

describe("حدّ الائتمان + موافقة المدير", () => {
  it("تجاوز السقف بلا موافقة ⇒ PRECONDITION_FAILED", async () => {
    await seed("100.00"); // سقف 100، البيع الآجل 200 ⇒ تجاوز
    await expect(creditSale()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("تجاوز السقف مع موافقة مدير (creditApproved) ⇒ ينجح", async () => {
    await seed("100.00");
    const r = await creditSale({ creditApproved: true });
    expect(r.invoiceId).toBeGreaterThan(0);
  });

  it("ضمن السقف ⇒ ينجح بلا موافقة", async () => {
    await seed("500.00"); // 200 < 500
    const r = await creditSale();
    expect(r.invoiceId).toBeGreaterThan(0);
  });

  it("سقف صفر (بلا حدّ) ⇒ ينجح بلا موافقة", async () => {
    await seed("0");
    const r = await creditSale();
    expect(r.invoiceId).toBeGreaterThan(0);
  });

  it("الرصيد القائم يُحتسب: سقف 250 ورصيد 100 وبيع 200 ⇒ تجاوز", async () => {
    await seed("250.00", "100.00"); // 100 + 200 = 300 > 250
    await expect(creditSale()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("بيع نقدي كامل ⇒ لا فحص ائتمان", async () => {
    await seed("50.00");
    const r = await createSale({ branchId: 1, customerId: 1, sourceType: "POS", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], payment: { amount: "200.00", method: "CASH" } }, actor);
    expect(r.invoiceId).toBeGreaterThan(0);
  });
});
