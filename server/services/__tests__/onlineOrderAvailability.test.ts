import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createOnlineOrder } from "../onlineOrderService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const baseOrder = {
  customerName: "Test customer",
  customerPhone: "07701234567",
  governorate: "baghdad",
  addressText: "Test address",
};

beforeEach(async () => {
  await truncateAllTables();
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Other", code: "OTHER", type: "SALES" },
  ]);
  await d.insert(s.products).values({ id: 1, name: "Store item", showInStore: true });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "STORE-1", costPrice: "1.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "piece", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 3 },
    { variantId: 1, branchId: 2, quantity: 100 },
  ]);
});

describe("createOnlineOrder availability guards", () => {
  it("rejects a requested quantity above stock, including duplicate cart lines", async () => {
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 4 }] }))
      .rejects.toThrow(/الكمية المطلوبة/);
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 2 }, { productUnitId: 1, quantity: 2 }] }))
      .rejects.toThrow(/الكمية المطلوبة/);
  });

  it("rejects a product hidden from the storefront", async () => {
    await db().update(s.products).set({ showInStore: false }).where(eq(s.products.id, 1));
    await expect(createOnlineOrder({ ...baseOrder, lines: [{ productUnitId: 1, quantity: 1 }] })).rejects.toThrow();
  });

  it("ignores a caller-supplied branch and always stores the order on MAIN", async () => {
    const created = await createOnlineOrder({ ...baseOrder, branchId: 2, lines: [{ productUnitId: 1, quantity: 1 }] });
    const order = (await db().select({ branchId: s.onlineOrders.branchId }).from(s.onlineOrders).where(eq(s.onlineOrders.id, created.orderId)))[0];
    expect(order?.branchId).toBe(1);
  });
});
