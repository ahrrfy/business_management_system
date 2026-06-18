import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("sales.create — حفظ dueDate للبيع الآجل (AR aging)", () => {
  it("dueDate يُحفظ على invoices حين يُمرَّر", async () => {
    const r = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        dueDate: "2026-07-15",
      },
      actor,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.invoiceId)))[0];
    expect(inv.dueDate).toBeTruthy();
    const ymd = inv.dueDate instanceof Date
      ? `${inv.dueDate.getFullYear()}-${String(inv.dueDate.getMonth() + 1).padStart(2, "0")}-${String(inv.dueDate.getDate()).padStart(2, "0")}`
      : String(inv.dueDate);
    expect(ymd).toBe("2026-07-15");
  });

  it("لا dueDate يُمرَّر ⇒ null على invoices (متوافق)", async () => {
    const r = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] },
      actor,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.invoiceId)))[0];
    expect(inv.dueDate).toBeNull();
  });
});
