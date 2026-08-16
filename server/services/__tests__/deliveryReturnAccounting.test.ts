import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { dispatchInvoiceToDelivery, returnConsignment } from "../deliveryService";
import { truncateTables } from "./__testUtils__";

const MANAGER = { userId: 1, branchId: 1, role: "manager" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

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
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "customers",
  "suppliers",
  "users",
  "branches",
];

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "delivery-return-manager", name: "Manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "delivery-return-courier", name: "Courier", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.customers).values({ id: 1, name: "Delivery customer", currentBalance: "0.00" });
  await db().insert(s.deliveryParties).values({
    id: 1,
    partyType: "INDIVIDUAL",
    name: "Courier",
    branchId: 1,
    userId: 2,
    defaultFee: "0.00",
    currentBalance: "0.00",
  });
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "delivery-return-accounting",
  });
}

interface ProductSeed {
  id: number;
  cost: string;
  isService?: boolean;
  isConsignment?: boolean;
  consignorId?: number | null;
  stockAfterSale?: number;
}

async function addProduct(input: ProductSeed) {
  await db().insert(s.products).values({
    id: input.id,
    name: `Product ${input.id}`,
    isService: input.isService ?? false,
    isConsignment: input.isConsignment ?? false,
    consignorId: input.consignorId ?? null,
  });
  await db().insert(s.productVariants).values({
    id: input.id,
    productId: input.id,
    sku: `DEL-RET-${input.id}`,
    costPrice: input.cost,
  });
  await db().insert(s.productUnits).values({
    id: input.id,
    variantId: input.id,
    unitName: "Piece",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  if (input.stockAfterSale != null) {
    await db().insert(s.branchStock).values({
      branchId: 1,
      variantId: input.id,
      quantity: input.stockAfterSale,
    });
  }
}

interface InvoiceLineSeed {
  productId: number;
  unitPrice: string;
  unitCost: string;
  total: string;
  isGift?: boolean;
  restoreStock?: boolean;
}

async function seedDispatchedInvoice(input: {
  invoiceId: number;
  subtotal: string;
  tax: string;
  total: string;
  costTotal: string;
  lines: InvoiceLineSeed[];
}) {
  await db().update(s.customers).set({ currentBalance: input.total }).where(eq(s.customers.id, 1));
  await db().insert(s.invoices).values({
    id: input.invoiceId,
    invoiceNumber: `INV-DEL-RET-${input.invoiceId}`,
    sourceType: "POS",
    sourceId: `delivery-return-${input.invoiceId}`,
    branchId: 1,
    customerId: 1,
    priceTier: "RETAIL",
    subtotal: input.subtotal,
    discountAmount: "0.00",
    taxAmount: input.tax,
    total: input.total,
    costTotal: input.costTotal,
    paidAmount: "0.00",
    returnedTotal: "0.00",
    status: "PENDING",
    createdBy: 1,
  });
  await db().insert(s.invoiceItems).values(input.lines.map((line, index) => ({
    id: input.invoiceId * 10 + index + 1,
    invoiceId: input.invoiceId,
    variantId: line.productId,
    productUnitId: line.productId,
    quantity: "1.000",
    baseQuantity: 1,
    unitPrice: line.unitPrice,
    unitCost: line.unitCost,
    total: line.total,
    isGift: line.isGift ?? false,
  })));
  const stockLines = input.lines.filter((line) => line.restoreStock);
  if (stockLines.length) {
    await db().insert(s.inventoryMovements).values(stockLines.map((line) => ({
      variantId: line.productId,
      branchId: 1,
      movementType: "OUT" as const,
      quantity: 1,
      referenceType: "INVOICE",
      referenceId: input.invoiceId,
      createdBy: 1,
    })));
  }
  const dispatched = await dispatchInvoiceToDelivery({
    invoiceId: input.invoiceId,
    partyId: 1,
    deliveryFee: "0.00",
    feeCollection: "COURIER",
    clientRequestId: `dispatch-delivery-return-${input.invoiceId}`,
  }, MANAGER);
  return dispatched.consignmentId;
}

async function returnEntry(invoiceId: number) {
  return (await db().select().from(s.accountingEntries).where(and(
    eq(s.accountingEntries.invoiceId, invoiceId),
    eq(s.accountingEntries.entryType, "RETURN"),
  )).limit(1))[0];
}

async function journalForSource(sourceEntryId: number) {
  const head = (await db().select().from(s.journalEntries).where(eq(s.journalEntries.entryId, sourceEntryId)).limit(1))[0];
  const lines = await db().select().from(s.journalLines).where(eq(s.journalLines.journalId, Number(head.id)));
  return { head, lines };
}

describe("delivery return — accounting mirrors", () => {
  beforeEach(async () => {
    await truncateTables(TABLES);
    await seedBase();
  });

  it("reverses consignment payable and supplier balance when the parcel returns to stock", async () => {
    await db().insert(s.suppliers).values({
      id: 1,
      name: "Consignor",
      supplierKind: "CONSIGNOR",
      currentBalance: "3000.00",
    });
    await addProduct({ id: 1, cost: "3000.00", isConsignment: true, consignorId: 1, stockAfterSale: 4 });
    const consignmentId = await seedDispatchedInvoice({
      invoiceId: 101,
      subtotal: "5000.00",
      tax: "0.00",
      total: "5000.00",
      costTotal: "3000.00",
      lines: [{ productId: 1, unitPrice: "5000.00", unitCost: "3000.00", total: "5000.00", restoreStock: true }],
    });

    await returnConsignment(consignmentId, { ...MANAGER, clientRequestId: "return-consignment-payable" });

    const supplier = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supplier.currentBalance).toBe("0.00");
    const purchase = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PURCHASE")))[0];
    expect(purchase.amount).toBe("-3000.00");
    expect(Number(purchase.supplierId)).toBe(1);
    const purchaseJournal = await journalForSource(Number(purchase.id));
    expect(purchaseJournal.head.status).toBe("POSTED");
    expect(purchaseJournal.head.postingProfile).toBe("PURCHASE_CONSIGNMENT");
    expect(purchaseJournal.lines.map((line) => [line.role, line.debit, line.credit])).toEqual([
      ["CONSIGNMENT_PAYABLE", "3000.00", "0.00"],
      ["COGS", "0.00", "3000.00"],
    ]);
    expect((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity).toBe(5);
  });

  it("reverses owned gift expense into inventory when the gifted item returns", async () => {
    await addProduct({ id: 1, cost: "2000.00", stockAfterSale: 4 });
    await addProduct({ id: 2, cost: "1000.00", stockAfterSale: 4 });
    const consignmentId = await seedDispatchedInvoice({
      invoiceId: 102,
      subtotal: "5000.00",
      tax: "0.00",
      total: "5000.00",
      costTotal: "2000.00",
      lines: [
        { productId: 1, unitPrice: "5000.00", unitCost: "2000.00", total: "5000.00", restoreStock: true },
        { productId: 2, unitPrice: "0.00", unitCost: "1000.00", total: "0.00", isGift: true, restoreStock: true },
      ],
    });

    await returnConsignment(consignmentId, { ...MANAGER, clientRequestId: "return-owned-gift" });

    const gift = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "GIFT_OUT")))[0];
    expect(gift.cost).toBe("-1000.00");
    expect(gift.profit).toBe("1000.00");
    const journal = await journalForSource(Number(gift.id));
    expect(journal.head.status).toBe("POSTED");
    expect(journal.head.postingProfile).toBe("GIFT_OUT_PROMO");
    expect(journal.lines.map((line) => [line.role, line.debit, line.credit])).toEqual([
      ["INVENTORY", "1000.00", "0.00"],
      ["GIFTS_PROMO", "0.00", "1000.00"],
    ]);
    expect((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 2)))[0].quantity).toBe(5);
  });

  it("uses RETURN_SALE_MIXED and reverses service and stocked revenue to their source roles", async () => {
    await addProduct({ id: 1, cost: "2000.00", stockAfterSale: 4 });
    await addProduct({ id: 2, cost: "0.00", isService: true });
    const consignmentId = await seedDispatchedInvoice({
      invoiceId: 103,
      subtotal: "10000.00",
      tax: "0.00",
      total: "10000.00",
      costTotal: "2000.00",
      lines: [
        { productId: 1, unitPrice: "6000.00", unitCost: "2000.00", total: "6000.00", restoreStock: true },
        { productId: 2, unitPrice: "4000.00", unitCost: "0.00", total: "4000.00" },
      ],
    });

    await returnConsignment(consignmentId, { ...MANAGER, clientRequestId: "return-mixed-sectors" });

    const entry = await returnEntry(103);
    const journal = await journalForSource(Number(entry.id));
    expect(journal.head.status).toBe("POSTED");
    expect(journal.head.postingProfile).toBe("RETURN_SALE_MIXED");
    expect(journal.lines.map((line) => [line.role, line.debit, line.credit])).toEqual([
      ["SALES_STATIONERY", "6000.00", "0.00"],
      ["SALES_PRINT", "4000.00", "0.00"],
      ["AR", "0.00", "10000.00"],
      ["INVENTORY", "2000.00", "0.00"],
      ["COGS", "0.00", "2000.00"],
    ]);
  });

  it("keeps operational return revenue and profit pre-tax while reversing tax separately", async () => {
    await addProduct({ id: 1, cost: "2000.00", stockAfterSale: 4 });
    const consignmentId = await seedDispatchedInvoice({
      invoiceId: 104,
      subtotal: "10000.00",
      tax: "1000.00",
      total: "11000.00",
      costTotal: "2000.00",
      lines: [{ productId: 1, unitPrice: "10000.00", unitCost: "2000.00", total: "10000.00", restoreStock: true }],
    });

    await returnConsignment(consignmentId, { ...MANAGER, clientRequestId: "return-taxed-delivery" });

    const entry = await returnEntry(104);
    expect(entry.revenue).toBe("-10000.00");
    expect(entry.cost).toBe("-2000.00");
    expect(entry.profit).toBe("-8000.00");
    expect(entry.taxAmount).toBe("-1000.00");
    expect(entry.amount).toBe("-11000.00");
    const journal = await journalForSource(Number(entry.id));
    expect(journal.head.status).toBe("POSTED");
    expect(journal.lines.some((line) => line.role === "TAX_PAYABLE" && line.debit === "1000.00")).toBe(true);
  });
});
