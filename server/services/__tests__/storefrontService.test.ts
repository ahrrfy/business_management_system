import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateAllTables } from "./__testUtils__";
import {
  createOnlineOrder,
  findOwnedOnlineOrderReplay,
} from "../onlineOrderService";
import { createVerifiedStorefrontOrder } from "../storefrontOrderGate";
import { createResourceAdmission } from "../../lib/resourceAdmission";
const db = () => {
  const d = getDb();
  if (!d) throw new Error("Synthetic database required");
  return d;
};
beforeEach(async () => {
  await truncateAllTables();
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Synthetic Main", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.products)
    .values({ id: 1, name: "Synthetic item", showInStore: true });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "LAB-REPLAY", costPrice: "1.00" });
  await db()
    .insert(s.productUnits)
    .values({
      id: 1,
      variantId: 1,
      unitName: "piece",
      isBaseUnit: true,
      isStoreSaleUnit: true,
    });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 10 });
  await db()
    .insert(s.storeSettings)
    .values({ id: 1, fulfillmentBranchId: 1, isOpen: true });
});
describe("admitted actual-service lost-response replay", () => {
  it("returns the committed order without a second token consumption, allocation or financial effect", async () => {
    const gate = createResourceAdmission({
      mode: "enforce",
      maxActiveCost: 4,
      publicMaxActiveCost: 3,
      readMaxActiveCost: 2,
      orderMaxActiveCost: 1,
      maxQueued: 1,
      maxQueuedCost: 1,
      queueTimeoutMs: 50,
    });
    const input = {
      customerName: "Synthetic customer",
      customerPhone: "07700000000",
      governorate: "baghdad",
      addressText: "Synthetic address",
      clientRequestId: "resource-replay-synthetic",
      lines: [{ productUnitId: 1, quantity: 2 }],
    };
    let verifies = 0;
    const deps = {
      findOwnedReplay: findOwnedOnlineOrderReplay,
      verifyTurnstile: async () => {
        verifies++;
      },
      createOrder: createOnlineOrder,
    };
    const run = async () => {
      const ticket = await gate.acquire("public-order");
      try {
        return await createVerifiedStorefrontOrder(input, "mock-token", deps);
      } finally {
        ticket.release();
      }
    };
    const snapshot = async () => ({
      orders: await db().select().from(s.onlineOrders),
      items: await db().select().from(s.onlineOrderItems),
      stock: await db().select().from(s.branchStock),
      invoices: await db()
        .select({ n: sql<number>`COUNT(*)` })
        .from(s.invoices),
      receipts: await db()
        .select({ n: sql<number>`COUNT(*)` })
        .from(s.receipts),
      entries: await db()
        .select({ n: sql<number>`COUNT(*)` })
        .from(s.accountingEntries),
    });
    const first = await run();
    const committed = await snapshot();
    const replay = await run();
    const afterReplay = await snapshot();
    expect(replay).toMatchObject({
      orderId: first.orderId,
      orderNumber: first.orderNumber,
      idempotentReplay: true,
    });
    expect(verifies).toBe(1);
    expect(afterReplay).toEqual(committed);
    expect(committed.orders).toHaveLength(1);
    expect(committed.orders[0].status).toBe("PENDING");
    expect(committed.items).toHaveLength(1);
    expect(committed.stock[0].quantity).toBe(10);
    for (const rows of [
      committed.invoices,
      committed.receipts,
      committed.entries,
    ])
      expect(Number(rows[0].n)).toBe(0);
    expect(gate.snapshot().activeCost).toBe(0);
  });
});
