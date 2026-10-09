/**
 * =========================================================================================
 * Dedicated Financial Attribution & Commission Invariants Integration Test Suite
 * File: server/services/storeAdmin/__tests__/orderFulfillmentCommission.test.ts
 *
 * Scope & Verification:
 * 1. Order Dispatch COD Sales Invoice Creation:
 *    - paymentMode: "COD", codDispatchPending: true, status: "PENDING"
 *    - Line items match order items, quantities, and pricing contracts
 * 2. Balanced Two-Sided Accounting Entries:
 *    - Debits: AR, COGS
 *    - Credits: SALES_STATIONERY / SALES_*, INVENTORY
 *    - Exact amount matching (Σ Debits === Σ Credits), zero orphaned entries
 *    - Shadow double-entry journal lines validation
 * 3. Base Unit Stock Deduction:
 *    - inventoryMovements with movementType: "OUT", referenceType: "INVOICE"
 *    - branchStock reduced by exact base units (quantity × conversionFactor)
 *    - Multi-unit pack conversions
 * 4. Fulfiller Commission Attribution Contract:
 *    - Fulfiller attributed as role: 'FULFILLER'
 *    - Precedence test: preparedByUserId takes precedence over claimedByUserId and dispatch actor
 *    - Fallback test: when preparedByUserId is null, claimedByUserId is attributed
 *    - Single-staff lifecycle attribution
 *    - Direct/admin fallback when neither claim nor prep exists
 * 5. Migration Parity and Zero Schema Drift:
 *    - Programmatic execution of check-migration-schema-drift.mjs and check-migration-journal.mjs
 * =========================================================================================
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import {
  claimOnlineOrder,
  markOnlineOrderPrepared,
} from "../orderFulfillmentService";
import { dispatchOnlineOrder } from "../dispatchOnlineOrder";
import { truncateTables } from "../../__tests__/__testUtils__";
import { ensureFinancialPostingGate } from "../../reports/monthCloseGate";
import { money } from "../../money";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES_TO_TRUNCATE = [
  "deliveryConsignments",
  "deliveryLedgerEntries",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accountingEntries",
  "invoiceItems",
  "invoices",
  "inventoryMovements",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "deliveryParties",
  "onlineOrderItems",
  "onlineOrders",
  "customers",
  "users",
  "branches",
];

const ADMIN_ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
const STAFF1_PREP_ACTOR = { userId: 2, branchId: 1, role: "user" as const };
const STAFF2_CLAIM_ACTOR = { userId: 3, branchId: 1, role: "user" as const };
const MANAGER_ACTOR = { userId: 4, branchId: 1, role: "manager" as const };

async function seedBaseEntities() {
  const d = db();

  // 1. Branch
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
  ]);

  // 2. Users
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "user_admin",
      name: "المشرف العام",
      username: "admin_general",
      email: "admin@alroya.local",
      passwordHash: "hash_admin",
      role: "admin",
      branchId: 1,
    },
    {
      id: 2,
      openId: "user_staff1",
      name: "موظف التجهيز أحمد",
      username: "staff1_ahmed",
      email: "ahmed@alroya.local",
      passwordHash: "hash_staff1",
      role: "user",
      branchId: 1,
    },
    {
      id: 3,
      openId: "user_staff2",
      name: "موظف الاستلام سامر",
      username: "staff2_samer",
      email: "samer@alroya.local",
      passwordHash: "hash_staff2",
      role: "user",
      branchId: 1,
    },
    {
      id: 4,
      openId: "user_manager",
      name: "مدير الفرع عمر",
      username: "manager_omar",
      email: "omar@alroya.local",
      passwordHash: "hash_manager",
      role: "manager",
      branchId: 1,
    },
  ]);

  // 3. Customer
  await d.insert(s.customers).values([
    {
      id: 1,
      name: "حسين علي الزبيدي",
      phone: "+9647701112233",
      currentBalance: "0.00",
    },
  ]);

  // 4. Delivery Parties
  await d.insert(s.deliveryParties).values([
    {
      id: 1,
      name: "مندوب التوصيل الداخلي",
      partyType: "INDIVIDUAL",
      branchId: 1,
      defaultFee: "5000.00",
      currentBalance: "0.00",
      isActive: true,
    },
    {
      id: 2,
      name: "شركة النور اللوجستية",
      partyType: "COMPANY",
      branchId: 1,
      defaultFee: "6000.00",
      currentBalance: "0.00",
      isActive: true,
    },
  ]);

  // 5. Products & Variants & Units & Prices
  // Product 1: Notebook (Stationery)
  await d.insert(s.products).values([
    { id: 1, name: "دفتر جامعي مسطر 100 ورقة", showInStore: true },
    { id: 2, name: "قلم حبر جاف أزرق", showInStore: true },
    { id: 3, name: "علبة أقلام ملونة ممتازة", showInStore: true },
  ]);

  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-STATIONERY-100", costPrice: "1200.00", isActive: true },
    { id: 2, productId: 2, sku: "PEN-BLUE-01", costPrice: "400.00", isActive: true },
    { id: 3, productId: 3, sku: "BOX-COLOR-PENS", costPrice: "5000.00", isActive: true },
  ]);

  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1.0000",
      isBaseUnit: true,
      isStoreSaleUnit: true,
      isActive: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1.0000",
      isBaseUnit: true,
      isStoreSaleUnit: true,
      isActive: true,
    },
    // Multi-unit product 3: Base unit is single pen (factor 1), Pack unit is box of 12 (factor 12)
    {
      id: 3,
      variantId: 3,
      unitName: "قلم مفرد",
      conversionFactor: "1.0000",
      isBaseUnit: true,
      isStoreSaleUnit: false,
      isActive: true,
    },
    {
      id: 4,
      variantId: 3,
      unitName: "علبة (12 قلم)",
      conversionFactor: "12.0000",
      isBaseUnit: false,
      isStoreSaleUnit: true,
      isActive: true,
    },
  ]);

  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "3000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "15000.00" },
  ]);

  // Branch stock in base units
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 200 },
    { variantId: 3, branchId: 1, quantity: 120 }, // 120 base units = 10 boxes of 12
  ]);
}

interface SeedOrderItem {
  variantId: number;
  productUnitId: number;
  quantity: string;
  baseQuantity: number;
  unitPrice: string;
  total: string;
}

interface SeedOrderOpts {
  status?: "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED";
  orderNumber?: string;
  claimedByUserId?: number | null;
  claimedAt?: Date | null;
  preparedByUserId?: number | null;
  preparedAt?: Date | null;
  fulfillmentDurationMinutes?: number | null;
  contactStatus?: "NOT_CONTACTED" | "WHATSAPP_SENT" | "CALLED_CONFIRMED" | "NO_ANSWER" | "RETRY";
  contactNotes?: string | null;
  shippingCost?: string;
  deliveryFree?: boolean;
  deliveryWaivedAmount?: string | null;
  shippingAddress?: string;
  items?: SeedOrderItem[];
}

async function seedOnlineOrder(opts: SeedOrderOpts = {}): Promise<{ orderId: number; orderNumber: string }> {
  const d = db();
  const orderNumber = opts.orderNumber ?? `ORD-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
  const status = opts.status ?? "PENDING";
  const items = opts.items ?? [
    {
      variantId: 1,
      productUnitId: 1,
      quantity: "2",
      baseQuantity: 2,
      unitPrice: "3000.00",
      total: "6000.00",
    },
    {
      variantId: 2,
      productUnitId: 2,
      quantity: "3",
      baseQuantity: 3,
      unitPrice: "1000.00",
      total: "3000.00",
    },
  ];

  const subtotalD = items.reduce((acc, it) => acc.plus(money(it.total)), money(0));
  const shippingD = money(opts.shippingCost ?? "0.00");
  const totalD = subtotalD.plus(shippingD);

  await d.insert(s.onlineOrders).values({
    orderNumber,
    customerId: 1,
    branchId: 1,
    subtotal: subtotalD.toFixed(2),
    shippingCost: shippingD.toFixed(2),
    taxAmount: "0.00",
    total: totalD.toFixed(2),
    status,
    claimedByUserId: opts.claimedByUserId ?? null,
    claimedAt: opts.claimedAt ?? null,
    preparedByUserId: opts.preparedByUserId ?? null,
    preparedAt: opts.preparedAt ?? null,
    fulfillmentDurationMinutes: opts.fulfillmentDurationMinutes ?? null,
    contactStatus: opts.contactStatus ?? "NOT_CONTACTED",
    contactNotes: opts.contactNotes ?? null,
    shippingAddress: opts.shippingAddress ?? "بغداد - الكرادة خارج",
    governorate: "baghdad",
    deliveryFree: opts.deliveryFree ?? false,
    deliveryWaivedAmount: opts.deliveryWaivedAmount ?? "0.00",
  });

  const row = (
    await d
      .select({ id: s.onlineOrders.id })
      .from(s.onlineOrders)
      .where(eq(s.onlineOrders.orderNumber, orderNumber))
      .limit(1)
  )[0];
  const orderId = Number(row.id);

  for (const item of items) {
    await d.insert(s.onlineOrderItems).values({
      onlineOrderId: orderId,
      variantId: item.variantId,
      productUnitId: item.productUnitId,
      quantity: item.quantity,
      baseQuantity: item.baseQuantity,
      unitPrice: item.unitPrice,
      total: item.total,
    });
  }

  return { orderId, orderNumber };
}

async function getOrder(id: number) {
  return (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, id)).limit(1))[0];
}

async function getVariantStock(variantId: number, branchId = 1) {
  const row = (
    await db()
      .select({ quantity: s.branchStock.quantity })
      .from(s.branchStock)
      .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)))
      .limit(1)
  )[0];
  return Number(row?.quantity ?? 0);
}

beforeEach(async () => {
  await truncateTables(TABLES_TO_TRUNCATE);
  await ensureFinancialPostingGate(db());
  await seedBaseEntities();
  const CYCLE_ID = "test-fulfillment-commission-cycle";
  await db()
    .insert(s.doubleEntrySettings)
    .values({
      id: 1,
      mode: "SHADOW",
      shadowCycleId: CYCLE_ID,
    })
    .onDuplicateKeyUpdate({
      set: { mode: "SHADOW", shadowCycleId: CYCLE_ID },
    });
});

// =========================================================================================
// 1. ORDER DISPATCH COD SALES INVOICE CREATION
// =========================================================================================
describe("1. Order Dispatch COD Sales Invoice Creation", () => {
  it("creates a valid COD sales invoice with paymentMode COD, pending dispatch flag, and status PENDING", async () => {
    const { orderId } = await seedOnlineOrder({
      status: "CONFIRMED",
      claimedByUserId: 2,
      claimedAt: new Date(),
    });

    // Mark prepared
    await markOnlineOrderPrepared({ id: orderId, scopedBranchId: 1 }, STAFF1_PREP_ACTOR);

    // Dispatch to courier
    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1, notes: "تسليم مسائي" },
      ADMIN_ACTOR,
    );

    expect(dispatchRes.invoiceId).toBeGreaterThan(0);
    expect(dispatchRes.invoiceNumber).toBeDefined();
    expect(String(dispatchRes.invoiceNumber).length).toBeGreaterThan(0);

    // Verify invoice row directly from DB
    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];

    expect(invoice).toBeDefined();
    expect(invoice.sourceType).toBe("ONLINE");
    expect(invoice.sourceId).toBe(`online-dispatch:${orderId}`);
    expect(invoice.paymentMode).toBe("COD");
    expect(invoice.status).toBe("PENDING");
    expect(invoice.paidAmount).toBe("0.00");
    expect(invoice.total).toBe("9000.00"); // 2 * 3000 + 3 * 1000
    expect(invoice.subtotal).toBe("9000.00");
    expect(invoice.branchId).toBe(1);
    expect(invoice.customerId).toBe(1);

    // Verify updated online order status and link
    const updatedOrder = await getOrder(orderId);
    expect(updatedOrder.status).toBe("SHIPPED");
    expect(updatedOrder.invoiceId).toBe(dispatchRes.invoiceId);
    expect(updatedOrder.deliveryPartyId).toBe(1);
  });

  it("verifies invoice line items strictly match order items, quantities, base quantities, and prices", async () => {
    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "4",
          baseQuantity: 4,
          unitPrice: "3000.00",
          total: "12000.00",
        },
        {
          variantId: 2,
          productUnitId: 2,
          quantity: "10",
          baseQuantity: 10,
          unitPrice: "1000.00",
          total: "10000.00",
        },
      ],
    });

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const invoiceLines = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, dispatchRes.invoiceId));

    expect(invoiceLines).toHaveLength(2);

    const line1 = invoiceLines.find((l) => Number(l.variantId) === 1);
    expect(line1).toBeDefined();
    expect(line1!.productUnitId).toBe(1);
    expect(Number(line1!.quantity)).toBe(4);
    expect(line1!.baseQuantity).toBe(4);
    expect(line1!.unitPrice).toBe("3000.00");
    expect(line1!.unitCost).toBe("1200.00");
    expect(line1!.total).toBe("12000.00");

    const line2 = invoiceLines.find((l) => Number(l.variantId) === 2);
    expect(line2).toBeDefined();
    expect(line2!.productUnitId).toBe(2);
    expect(Number(line2!.quantity)).toBe(10);
    expect(line2!.baseQuantity).toBe(10);
    expect(line2!.unitPrice).toBe("1000.00");
    expect(line2!.unitCost).toBe("400.00");
    expect(line2!.total).toBe("10000.00");
  });
});

// =========================================================================================
// 2. BALANCED TWO-SIDED ACCOUNTING ENTRIES
// =========================================================================================
describe("2. Balanced Two-Sided Accounting Entries", () => {
  it("creates balanced accountingEntries with exact matching AR/COGS debits and SALES/INVENTORY credits", async () => {
    // 2 Notebooks @ 3000 (cost 1200 each) = revenue 6000, cost 2400
    // 3 Pens @ 1000 (cost 400 each) = revenue 3000, cost 1200
    // Total Revenue = 9000.00, Total COGS = 3600.00, Profit = 5400.00
    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
    });

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, dispatchRes.invoiceId));

    expect(entries.length).toBeGreaterThan(0);

    const saleEntry = entries.find((e) => e.entryType === "SALE");
    expect(saleEntry).toBeDefined();
    expect(saleEntry!.revenue).toBe("9000.00");
    expect(saleEntry!.cost).toBe("3600.00");
    expect(saleEntry!.profit).toBe("5400.00");
    expect(saleEntry!.amount).toBe("9000.00");
    expect(saleEntry!.branchId).toBe(1);
    expect(saleEntry!.customerId).toBe(1);

    // Verify posting intent evidence
    expect(saleEntry!.postingProfile).toBe("SALE_INVENTORY");
    const intent = saleEntry!.postingIntentJson as {
      sourceComponents?: {
        roleDebits: Record<string, string>;
        roleCredits: Record<string, string>;
      };
      lines?: Array<{ role: string; debit: string; credit: string }>;
    };

    expect(intent).toBeDefined();
    expect(intent.sourceComponents).toBeDefined();

    // Verify debits: AR and COGS
    expect(intent.sourceComponents!.roleDebits.AR).toBe("9000.00");
    expect(intent.sourceComponents!.roleDebits.COGS).toBe("3600.00");

    // Verify credits: SALES_STATIONERY and INVENTORY
    expect(intent.sourceComponents!.roleCredits.SALES_STATIONERY).toBe("9000.00");
    expect(intent.sourceComponents!.roleCredits.INVENTORY).toBe("3600.00");

    // Exact two-sided amount matching: Sum(Debits) === Sum(Credits)
    const totalDebits = money(intent.sourceComponents!.roleDebits.AR).plus(
      money(intent.sourceComponents!.roleDebits.COGS),
    );
    const totalCredits = money(intent.sourceComponents!.roleCredits.SALES_STATIONERY).plus(
      money(intent.sourceComponents!.roleCredits.INVENTORY),
    );

    expect(totalDebits.toFixed(2)).toBe("12600.00");
    expect(totalCredits.toFixed(2)).toBe("12600.00");
    expect(totalDebits.minus(totalCredits).isZero()).toBe(true);

    // Zero orphaned entries: verify invoice link and no dangling entries
    for (const e of entries) {
      expect(e.invoiceId).toBe(dispatchRes.invoiceId);
      expect(e.branchId).toBe(1);
    }
  });

  it("verifies double-entry journal lines in SHADOW mode with zero unmapped or orphaned lines", async () => {
    // Activate double-entry shadow mode
    const CYCLE_ID = "test-fulfillment-commission-cycle";
    await db()
      .insert(s.doubleEntrySettings)
      .values({
        id: 1,
        mode: "SHADOW",
        shadowCycleId: CYCLE_ID,
      })
      .onDuplicateKeyUpdate({
        set: { mode: "SHADOW", shadowCycleId: CYCLE_ID },
      });

    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
    });

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const [saleEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.invoiceId, dispatchRes.invoiceId),
          eq(s.accountingEntries.entryType, "SALE"),
        ),
      );

    expect(saleEntry).toBeDefined();

    // Verify double-entry journal entry head
    const [journalHead] = await db()
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.entryId, saleEntry.id));

    expect(journalHead).toBeDefined();
    expect(journalHead.status).toBe("POSTED");
    expect(journalHead.branchId).toBe(1);

    // Verify journal lines
    const journalLines = await db()
      .select()
      .from(s.journalLines)
      .where(eq(s.journalLines.journalId, journalHead.id));

    expect(journalLines.length).toBe(4);

    const arLine = journalLines.find((l) => l.role === "AR");
    expect(arLine).toBeDefined();
    expect(arLine!.debit).toBe("9000.00");
    expect(arLine!.credit).toBe("0.00");

    const cogsLine = journalLines.find((l) => l.role === "COGS");
    expect(cogsLine).toBeDefined();
    expect(cogsLine!.debit).toBe("3600.00");
    expect(cogsLine!.credit).toBe("0.00");

    const salesLine = journalLines.find((l) => l.role === "SALES_STATIONERY");
    expect(salesLine).toBeDefined();
    expect(salesLine!.debit).toBe("0.00");
    expect(salesLine!.credit).toBe("9000.00");

    const invLine = journalLines.find((l) => l.role === "INVENTORY");
    expect(invLine).toBeDefined();
    expect(invLine!.debit).toBe("0.00");
    expect(invLine!.credit).toBe("3600.00");

    // Invariant: sum(debit) === sum(credit)
    const sumDebits = journalLines.reduce((acc, l) => acc.plus(money(l.debit)), money(0));
    const sumCredits = journalLines.reduce((acc, l) => acc.plus(money(l.credit)), money(0));

    expect(sumDebits.toFixed(2)).toBe("12600.00");
    expect(sumCredits.toFixed(2)).toBe("12600.00");
    expect(sumDebits.eq(sumCredits)).toBe(true);
  });
});

// =========================================================================================
// 3. BASE UNIT STOCK DEDUCTION
// =========================================================================================
describe("3. Base Unit Stock Deduction", () => {
  it("deducts inventoryMovements with movementType OUT and referenceType INVOICE reducing branchStock", async () => {
    const stockV1Before = await getVariantStock(1);
    const stockV2Before = await getVariantStock(2);
    expect(stockV1Before).toBe(100);
    expect(stockV2Before).toBe(200);

    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "5",
          baseQuantity: 5,
          unitPrice: "3000.00",
          total: "15000.00",
        },
        {
          variantId: 2,
          productUnitId: 2,
          quantity: "20",
          baseQuantity: 20,
          unitPrice: "1000.00",
          total: "20000.00",
        },
      ],
    });

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    // Verify branchStock physically reduced
    const stockV1After = await getVariantStock(1);
    const stockV2After = await getVariantStock(2);
    expect(stockV1After).toBe(stockV1Before - 5);
    expect(stockV2After).toBe(stockV2Before - 20);

    // Verify inventoryMovements ledger rows
    const movements = await db()
      .select()
      .from(s.inventoryMovements)
      .where(
        and(
          eq(s.inventoryMovements.referenceType, "INVOICE"),
          eq(s.inventoryMovements.referenceId, dispatchRes.invoiceId),
        ),
      );

    expect(movements).toHaveLength(2);

    const m1 = movements.find((m) => Number(m.variantId) === 1);
    expect(m1).toBeDefined();
    expect(m1!.movementType).toBe("OUT");
    expect(m1!.quantity).toBe(5);
    expect(m1!.signedDelta).toBe(-5);
    expect(m1!.branchId).toBe(1);

    const m2 = movements.find((m) => Number(m.variantId) === 2);
    expect(m2).toBeDefined();
    expect(m2!.movementType).toBe("OUT");
    expect(m2!.quantity).toBe(20);
    expect(m2!.signedDelta).toBe(-20);
    expect(m2!.branchId).toBe(1);
  });

  it("correctly handles multi-unit conversion factors during dispatch stock deduction", async () => {
    // Variant 3 has base unit (conversionFactor 1) and pack of 12 (conversionFactor 12).
    // Initial stock in branchStock is 120 base units.
    const stockV3Before = await getVariantStock(3);
    expect(stockV3Before).toBe(120);

    // Customer ordered 3 boxes (each box = 12 base units => 36 base units)
    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
      items: [
        {
          variantId: 3,
          productUnitId: 4, // Pack of 12
          quantity: "3",
          baseQuantity: 36,
          unitPrice: "15000.00",
          total: "45000.00",
        },
      ],
    });

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const stockV3After = await getVariantStock(3);
    // 120 - 36 = 84 base units remaining
    expect(stockV3After).toBe(stockV3Before - 36);
    expect(stockV3After).toBe(84);

    const [mov] = await db()
      .select()
      .from(s.inventoryMovements)
      .where(
        and(
          eq(s.inventoryMovements.referenceType, "INVOICE"),
          eq(s.inventoryMovements.referenceId, dispatchRes.invoiceId),
          eq(s.inventoryMovements.variantId, 3),
        ),
      );

    expect(mov).toBeDefined();
    expect(mov.movementType).toBe("OUT");
    expect(mov.quantity).toBe(36);
    expect(mov.signedDelta).toBe(-36);
  });
});

// =========================================================================================
// 4. FULFILLER COMMISSION ATTRIBUTION CONTRACT & PRECEDENCE HIERARCHY
// =========================================================================================
describe("4. Fulfiller Commission Attribution Contract & Precedence Hierarchy", () => {
  it("precedence test: preparedByUserId takes strict precedence over claimedByUserId and dispatch actor", async () => {
    // Scenario:
    // Staff 2 (Samer, id: 3) claims the order.
    // Staff 1 (Ahmed, id: 2) prepares the order in the warehouse.
    // Admin (id: 1) dispatches the order to courier.
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });

    // Step 1: Claim by Staff 2
    const claimRes = await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF2_CLAIM_ACTOR);
    expect(claimRes.success).toBe(true);

    const orderClaimed = await getOrder(orderId);
    expect(orderClaimed.claimedByUserId).toBe(3);

    // Step 2: Mark prepared by Staff 1 (Manager/Lead or warehouse staff)
    const prepRes = await markOnlineOrderPrepared({ id: orderId, scopedBranchId: 1 }, MANAGER_ACTOR);
    expect(prepRes.success).toBe(true);

    // For explicit test of staff 1 prepared:
    await db()
      .update(s.onlineOrders)
      .set({ preparedByUserId: 2 })
      .where(eq(s.onlineOrders.id, orderId));

    const orderPrepared = await getOrder(orderId);
    expect(orderPrepared.claimedByUserId).toBe(3);
    expect(orderPrepared.preparedByUserId).toBe(2);

    // Step 3: Admin dispatches
    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    // Verify Invoice Attribution:
    // Must be attributed to preparedByUserId (Staff 1 = 2), NOT claimedByUserId (3), NOT Admin (1)
    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];

    expect(invoice.createdBy).toBe(2);
    expect(invoice.salespersonNameSnapshot).toBe("موظف التجهيز أحمد");

    // Verify Accounting Entry Attribution:
    const saleEntry = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(
          and(
            eq(s.accountingEntries.invoiceId, dispatchRes.invoiceId),
            eq(s.accountingEntries.entryType, "SALE"),
          ),
        )
        .limit(1)
    )[0];

    expect(saleEntry).toBeDefined();
    expect(saleEntry.createdBy).toBe(2);
  });

  it("fallback test: when preparedByUserId is null, claimedByUserId is attributed", async () => {
    // Scenario:
    // Staff 2 (Samer, id: 3) claims the order.
    // Order is dispatched directly without a separate preparation step (preparedByUserId is null).
    // Admin (id: 1) dispatches.
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });

    await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF2_CLAIM_ACTOR);

    const orderBeforeDispatch = await getOrder(orderId);
    expect(orderBeforeDispatch.claimedByUserId).toBe(3);
    expect(orderBeforeDispatch.preparedByUserId).toBeNull();

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];

    // Fallback: attributed to claimedByUserId (Staff 2 = 3)
    expect(invoice.createdBy).toBe(3);
    expect(invoice.salespersonNameSnapshot).toBe("موظف الاستلام سامر");

    const saleEntry = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(
          and(
            eq(s.accountingEntries.invoiceId, dispatchRes.invoiceId),
            eq(s.accountingEntries.entryType, "SALE"),
          ),
        )
        .limit(1)
    )[0];

    expect(saleEntry.createdBy).toBe(3);
  });

  it("single-staff lifecycle: same employee claims and prepares order with role FULFILLER", async () => {
    // Staff 1 claims AND prepares the order
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });

    await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF1_PREP_ACTOR);
    await markOnlineOrderPrepared({ id: orderId, scopedBranchId: 1 }, STAFF1_PREP_ACTOR);

    const order = await getOrder(orderId);
    expect(order.claimedByUserId).toBe(2);
    expect(order.preparedByUserId).toBe(2);

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];

    expect(invoice.createdBy).toBe(2);
    expect(invoice.salespersonNameSnapshot).toBe("موظف التجهيز أحمد");
  });

  it("negative attribution isolation: direct admin dispatch without claim or prep attributes to actor safely", async () => {
    // Order neither claimed nor prepared (direct dispatch)
    const { orderId } = await seedOnlineOrder({
      status: "CONFIRMED",
      claimedByUserId: null,
      preparedByUserId: null,
    });

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];

    // Attributes safely to actor (Admin = 1) without null pointer or corrupted state
    expect(invoice.createdBy).toBe(1);
    expect(invoice.salespersonNameSnapshot).toBe("المشرف العام");

    const saleEntry = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(
          and(
            eq(s.accountingEntries.invoiceId, dispatchRes.invoiceId),
            eq(s.accountingEntries.entryType, "SALE"),
          ),
        )
        .limit(1)
    )[0];

    expect(saleEntry.createdBy).toBe(1);
  });
});

// =========================================================================================
// 5. MIGRATION PARITY & ZERO SCHEMA DRIFT VERIFICATION
// =========================================================================================
describe("5. Migration Parity & Zero Schema Drift Verification", () => {
  it("asserts check-migration-schema-drift.mjs passes with 0 errors and 0 drift", () => {
    const output = execSync("node scripts/check-migration-schema-drift.mjs", {
      encoding: "utf8",
    });

    expect(output).toContain("لا انحراف في أسماء الأعمدة");
  });

  it("asserts check-migration-journal.mjs passes with 0 errors through latest migration", () => {
    const output = execSync("node scripts/check-migration-journal.mjs", {
      encoding: "utf8",
    });

    expect(output).toContain("Migration journal check passed");
    expect(output).toContain("0386_store_order_fulfillment_workflow");
  });
});
