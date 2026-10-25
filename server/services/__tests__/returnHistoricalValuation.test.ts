import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

const owner = { userId: 1, branchId: 1, role: "admin" as const };
const TABLES = [
  "documentEffects",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "customers",
  "users",
  "branches",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seed() {
  await db().insert(s.branches).values({
    id: 1,
    name: "MAIN",
    code: "MAIN",
    type: "MAIN",
  });
  await db().insert(s.users).values({
    id: 1,
    openId: "historical-return-owner",
    name: "Owner",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
    isOwner: true,
    isActive: true,
  });
  await db().insert(s.categories).values({ id: 1, name: "Stationery" });
  await db().insert(s.products).values({
    id: 1,
    name: "Historical item",
    categoryId: 1,
  });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "HIST-1",
    costPrice: "100.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "Piece",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(s.productPrices).values({
    productUnitId: 1,
    priceTier: "RETAIL",
    price: "500.00",
  });
  await db().insert(s.customers).values({
    id: 1,
    name: "Credit customer",
    defaultPriceTier: "RETAIL",
    currentBalance: "0.00",
    creditLimit: null,
  });
  await db().insert(s.branchStock).values({
    variantId: 1,
    branchId: 1,
    quantity: 20,
  });
}

async function createHistoricalSale(quantity: string) {
  const sale = await createSale(
    {
      branchId: 1,
      customerId: 1,
      sourceType: "ORDER",
      lines: [{ variantId: 1, productUnitId: 1, quantity }],
    },
    owner,
  );
  const item = (
    await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, sale.invoiceId))
  )[0]!;
  return { sale, item };
}

async function resetCurrentPool() {
  await db()
    .update(s.branchStock)
    .set({ quantity: 10 })
    .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
  await db()
    .update(s.productVariants)
    .set({ costPrice: "200.00" })
    .where(eq(s.productVariants.id, 1));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("ordinary sale return historical valuation", () => {
  it("mixes one unit issued at 100 into 10 current units at 200", async () => {
    const { sale, item } = await createHistoricalSale("3");
    await resetCurrentPool();

    await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        refund: null,
        restock: true,
        operatorReason: "partial historical return",
      },
      owner,
    );

    const stock = (
      await db()
        .select()
        .from(s.branchStock)
        .where(
          and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)),
        )
    )[0]!;
    const variant = (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0]!;
    expect(stock.quantity).toBe(11);
    expect(variant.costPrice).toBe("190.91");
  });

  it("does not add stock or change WAVG when the returned unit is damaged", async () => {
    const { sale, item } = await createHistoricalSale("3");
    await resetCurrentPool();

    const input = {
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      refund: null,
      restock: false,
      operatorReason: "damaged partial item",
      clientRequestId: "partial-damaged-historical-reclass",
    } as const;
    await returnSale(input, owner);
    await returnSale(input, owner);

    const stock = (
      await db()
        .select()
        .from(s.branchStock)
        .where(eq(s.branchStock.variantId, 1))
    )[0]!;
    const variant = (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0]!;
    expect(stock.quantity).toBe(10);
    expect(variant.costPrice).toBe("200.00");

    const movements = await db()
      .select()
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceId, sale.invoiceId));
    expect(movements.filter((movement) => movement.movementType === "RETURN")).toHaveLength(0);
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, sale.invoiceId));
    const returned = entries.find((entry) => entry.entryType === "RETURN")!;
    const reclassifications = entries.filter((entry) =>
      entry.dedupeKey?.startsWith("DAMAGED_RETURN_RECLASS:"),
    );
    expect(reclassifications).toHaveLength(1);
    expect(reclassifications[0]).toMatchObject({
      dedupeKey: `DAMAGED_RETURN_RECLASS:${returned.id}`,
      amount: "0.00",
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
      taxAmount: "0.00",
    });
    // الربح التشغيلي لم يُصنع أو يُحذف بالقيد التصنيفي: 1200 − 500 = 700.
    expect(entries.reduce((sum, entry) => sum + Number(entry.profit), 0)).toBe(700);
  });
});
