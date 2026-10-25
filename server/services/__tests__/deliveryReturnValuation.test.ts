import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnConsignment } from "../delivery/returns";
import { dispatchInvoiceToDelivery } from "../deliveryService";
import { truncateTables } from "./__testUtils__";

const manager = { userId: 1, branchId: 1, role: "manager" as const };
const TABLES = [
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
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
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "delivery-valuation-manager",
        name: "Manager",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "delivery-valuation-courier",
        name: "Courier",
        role: "courier",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "Delivery customer",
    currentBalance: "0.00",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    partyType: "INDIVIDUAL",
    name: "Courier",
    branchId: 1,
    userId: 2,
    defaultFee: "0.00",
    currentBalance: "0.00",
  });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "Stocked item" },
      { id: 2, name: "Consumed service", isService: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "DEL-STOCK-1", costPrice: "200.00" },
      { id: 2, productId: 2, sku: "DEL-SERVICE-1", costPrice: "0.00" },
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
        unitName: "Service",
        conversionFactor: "1",
        isBaseUnit: true,
      },
    ]);
  await db().insert(s.branchStock).values({
    branchId: 1,
    variantId: 1,
    quantity: 10,
  });
}

async function dispatchedInvoice(input: {
  invoiceId: number;
  itemVariantId: number;
  lineCost: string;
  issuedVariantId: number;
}) {
  await db()
    .update(s.customers)
    .set({ currentBalance: "500.00" })
    .where(eq(s.customers.id, 1));
  await db()
    .insert(s.invoices)
    .values({
      id: input.invoiceId,
      invoiceNumber: `INV-DEL-HIST-${input.invoiceId}`,
      sourceType: "POS",
      sourceId: `delivery-historical-${input.invoiceId}`,
      branchId: 1,
      customerId: 1,
      priceTier: "RETAIL",
      subtotal: "500.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      total: "500.00",
      costTotal: input.lineCost,
      paidAmount: "0.00",
      returnedTotal: "0.00",
      status: "PENDING",
      createdBy: 1,
    });
  await db()
    .insert(s.invoiceItems)
    .values({
      id: input.invoiceId * 10,
      invoiceId: input.invoiceId,
      variantId: input.itemVariantId,
      productUnitId: input.itemVariantId,
      quantity: "1.000",
      baseQuantity: 1,
      unitPrice: "500.00",
      unitCost: input.lineCost,
      lineCost: input.lineCost,
      serviceMaterialsSnapshotted: input.itemVariantId === 2,
      total: "500.00",
    });
  await db().insert(s.inventoryMovements).values({
    variantId: input.issuedVariantId,
    branchId: 1,
    movementType: "OUT",
    quantity: 1,
    referenceType: "INVOICE",
    referenceId: input.invoiceId,
    createdBy: 1,
  });
  const dispatched = await dispatchInvoiceToDelivery(
    {
      assignedUserId: 2,
      invoiceId: input.invoiceId,
      partyId: 1,
      deliveryFee: "0.00",
      feeCollection: "COURIER",
      clientRequestId: `dispatch-historical-${input.invoiceId}`,
    },
    manager,
  );
  return dispatched.consignmentId;
}

async function stockAndCost() {
  const stock = (
    await db()
      .select()
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)))
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

describe("delivery return valuation", () => {
  it("returns stocked goods at invoice issue value", async () => {
    const consignmentId = await dispatchedInvoice({
      invoiceId: 100,
      itemVariantId: 1,
      lineCost: "100.00",
      issuedVariantId: 1,
    });

    await returnConsignment(consignmentId, {
      ...manager,
      clientRequestId: "delivery-historical-return-100",
      returnReason: "customer refused",
    });

    expect(await stockAndCost()).toEqual({ quantity: 11, cost: "190.91" });
  });

  it("does not return a service or its consumed material to stock", async () => {
    const consignmentId = await dispatchedInvoice({
      invoiceId: 101,
      itemVariantId: 2,
      lineCost: "100.00",
      issuedVariantId: 1,
    });

    await returnConsignment(consignmentId, {
      ...manager,
      clientRequestId: "delivery-service-return-101",
      returnReason: "customer refused",
    });

    expect(await stockAndCost()).toEqual({ quantity: 10, cost: "200.00" });
    const item = (
      await db()
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, 101))
    )[0]!;
    expect(item.returnedBaseQuantity).toBe(1);
    expect(item.returnedRestockedBaseQuantity).toBe(0);
  });
});
