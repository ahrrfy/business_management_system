import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelSale } from "../sale/cancel";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { truncateTables } from "./__testUtils__";

const owner = { userId: 1, branchId: 1, role: "admin" as const };
const TABLES = [
  "documentEffects",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemServiceMaterials",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "bundleComponents",
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
    openId: "reversal-valuation-owner",
    name: "Owner",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
    isOwner: true,
    isActive: true,
  });
  await db().insert(s.categories).values({ id: 1, name: "Stationery" });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "Component", categoryId: 1 },
      { id: 2, name: "Bundle", categoryId: 1, isBundle: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "COMP-1", costPrice: "100.00" },
      { id: 2, productId: 2, sku: "BUNDLE-1", costPrice: "0.00" },
    ]);
  await db()
    .insert(s.productUnits)
    .values([
      {
        id: 1,
        variantId: 1,
        unitName: "Piece",
        conversionFactor: "1",
        isBaseUnit: true,
      },
      {
        id: 2,
        variantId: 2,
        unitName: "Bundle",
        conversionFactor: "1",
        isBaseUnit: true,
      },
    ]);
  await db()
    .insert(s.productPrices)
    .values([
      { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
      { productUnitId: 2, priceTier: "RETAIL", price: "700.00" },
    ]);
  await db().insert(s.bundleComponents).values({
    bundleVariantId: 2,
    componentVariantId: 1,
    componentBaseQuantity: 1,
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

async function setCurrentPool() {
  await db()
    .update(s.branchStock)
    .set({ quantity: 10 })
    .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
  await db()
    .update(s.productVariants)
    .set({ costPrice: "200.00" })
    .where(eq(s.productVariants.id, 1));
}

async function stockAndCost() {
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
  return { quantity: stock.quantity, cost: variant.costPrice };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("invoice reversal historical valuation", () => {
  it("full reversal restores a stocked item at original issue value", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      owner,
    );
    await setCurrentPool();

    await cancelSale(
      { invoiceId: sale.invoiceId, reason: "full historical reversal" },
      owner,
    );

    expect(await stockAndCost()).toEqual({ quantity: 11, cost: "190.91" });
  });

  it("restores bundle components, never the bundle head, at component issue value", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      },
      owner,
    );
    await setCurrentPool();

    await cancelSale(
      { invoiceId: sale.invoiceId, reason: "bundle historical reversal" },
      owner,
    );

    expect(await stockAndCost()).toEqual({ quantity: 11, cost: "190.91" });
    expect(
      await db()
        .select()
        .from(s.branchStock)
        .where(eq(s.branchStock.variantId, 2)),
    ).toHaveLength(0);
  });

  it("fails closed when a legacy bundle has no issue-cost evidence", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      },
      owner,
    );
    const item = (
      await db()
        .select({ id: s.invoiceItems.id })
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, sale.invoiceId))
    )[0]!;
    await db()
      .update(s.invoiceItemBundleComponents)
      .set({ issueUnitCost: null, issueLineCost: null })
      .where(eq(s.invoiceItemBundleComponents.invoiceItemId, Number(item.id)));
    await setCurrentPool();

    await expect(
      cancelSale(
        { invoiceId: sale.invoiceId, reason: "legacy bundle reversal" },
        owner,
      ),
    ).rejects.toThrow(/مراجعة تكلفة/);
    expect(await stockAndCost()).toEqual({ quantity: 10, cost: "200.00" });
  });

  it("full damaged bundle reclassifies owned historical cost once without inventory or analytical duplication", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }],
      },
      owner,
    );
    const item = (
      await db()
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, sale.invoiceId))
    )[0]!;
    await setCurrentPool();
    const input = {
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      refund: null,
      restock: false,
      operatorReason: "full damaged bundle",
      clientRequestId: "full-damaged-bundle-reclass",
    } as const;

    await returnSale(input, owner);
    await returnSale(input, owner);

    expect(await stockAndCost()).toEqual({ quantity: 10, cost: "200.00" });
    expect(
      await db()
        .select()
        .from(s.branchStock)
        .where(eq(s.branchStock.variantId, 2)),
    ).toHaveLength(0);
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
    expect(
      entries.reduce((sum, entry) => sum + Number(entry.profit), 0),
    ).toBe(-100);
  });
});
