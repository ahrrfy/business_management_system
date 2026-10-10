/**
 * =========================================================================================
 * Comprehensive Requirement-Driven Opaque-Box E2E Test Suite:
 * Store Order Fulfillment Automation & Commission Integration Subsystem
 *
 * Covers 4 Tiers:
 * - Tier 1: Feature Coverage (Claims, Contacts, Prep, COD Invoice Dispatch, Inventory, Sweeper)
 * - Tier 2: Boundary & Corner Cases (Concurrency race condition, 24h expiration, Illegal transitions)
 * - Tier 3: Cross-Feature Combinations (Claims -> Prep -> Dispatch -> Commission attribution hierarchy)
 * - Tier 4: Real-World Scenarios (Full customer order lifecycle, multi-staff processing, edge recovery)
 * =========================================================================================
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import {
  claimOnlineOrder,
  markOnlineOrderPrepared,
  setOnlineOrderStatus,
  updateOnlineOrderContact,
} from "../orderFulfillmentService";
import { dispatchOnlineOrder } from "../dispatchOnlineOrder";
import { sweepExpiredOnlineOrdersOnce } from "../../onlineOrderExpirySweeper";
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
  "storefrontPushDeliveries",
  "storefrontPushCampaigns",
  "storefrontPushDevices",
  "onlineOrderItems",
  "onlineOrders",
  "customers",
  "users",
  "branches",
];

const ADMIN_ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
const STAFF1_ACTOR = { userId: 2, branchId: 1, role: "user" as const };
const STAFF2_ACTOR = { userId: 3, branchId: 1, role: "user" as const };
const MANAGER_ACTOR = { userId: 4, branchId: 1, role: "manager" as const };

async function seedBaseEntities() {
  const d = db();

  // 1. Branches
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
  ]);

  // 2. Users (Admin, Staff 1, Staff 2, Manager)
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "user_admin",
      name: "المشرف العام",
      username: "admin_test",
      email: "admin@test.com",
      passwordHash: "h",
      role: "admin",
      branchId: 1,
    },
    {
      id: 2,
      openId: "user_staff1",
      name: "موظف التجهيز 1",
      username: "staff1_test",
      email: "staff1@test.com",
      passwordHash: "h",
      role: "user",
      branchId: 1,
    },
    {
      id: 3,
      openId: "user_staff2",
      name: "موظف التجهيز 2",
      username: "staff2_test",
      email: "staff2@test.com",
      passwordHash: "h",
      role: "user",
      branchId: 1,
    },
    {
      id: 4,
      openId: "user_manager",
      name: "مدير الفرع",
      username: "manager_test",
      email: "manager@test.com",
      passwordHash: "h",
      role: "manager",
      branchId: 1,
    },
  ]);

  // 3. Customer
  await d.insert(s.customers).values([
    {
      id: 1,
      name: "أحمد العراقي",
      phone: "+9647701234567",
      currentBalance: "0.00",
    },
  ]);

  // 4. Delivery Parties:
  // Party 1: Individual courier (no external tracking ref required)
  // Party 2: Company courier (external tracking ref strictly required)
  await d.insert(s.deliveryParties).values([
    {
      id: 1,
      name: "مندوب الفرع الداخلي",
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
      defaultFee: "5000.00",
      currentBalance: "0.00",
      isActive: true,
    },
  ]);

  // 5. Products & Inventory
  await d.insert(s.products).values([
    { id: 1, name: "دفتر جامعي 100 ورقة", showInStore: true },
    { id: 2, name: "قلم جاف أزرق فاخر", showInStore: true },
  ]);

  // Variants
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-100", costPrice: "1000.00", isActive: true },
    { id: 2, productId: 2, sku: "PEN-BLUE", costPrice: "500.00", isActive: true },
  ]);

  // Product Units
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
  ]);

  // Product Prices
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "2500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000.00" },
  ]);

  // Branch Stock
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 100 },
  ]);
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
  orderDate?: Date;
  reservationExpiresAt?: Date | null;
  shippingCost?: string;
  deliveryFree?: boolean;
  deliveryPartyId?: number | null;
  invoiceId?: number | null;
  items?: Array<{
    variantId: number;
    productUnitId: number;
    quantity: string;
    baseQuantity: number;
    unitPrice: string;
    total: string;
  }>;
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
      unitPrice: "2500.00",
      total: "5000.00",
    },
  ];

  const subtotalD = items.reduce((acc, it) => acc.plus(money(it.total)), money(0));
  const shippingD = money(opts.shippingCost ?? "5000.00");
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
    shippingAddress: "حي المنصور، بغداد",
    governorate: "baghdad",
    deliveryFree: opts.deliveryFree ?? false,
    deliveryPartyId: opts.deliveryPartyId ?? null,
    invoiceId: opts.invoiceId ?? null,
    ...(opts.orderDate ? { orderDate: opts.orderDate } : {}),
    ...(opts.reservationExpiresAt !== undefined ? { reservationExpiresAt: opts.reservationExpiresAt } : {}),
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
});

// =========================================================================================
// TIER 1: FEATURE COVERAGE (ISOLATION HAPPY PATHS)
// =========================================================================================
describe("Tier 1: Feature Coverage (Isolation Happy Paths)", () => {
  it("T1.1: Feature 1 - Claim Online Order (PENDING -> CONFIRMED with claimedByUserId)", async () => {
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });

    const result = await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF1_ACTOR);

    expect(result.success).toBe(true);
    expect(result.claimedByUserId).toBe(2);

    const order = await getOrder(orderId);
    expect(order.status).toBe("CONFIRMED");
    expect(order.claimedByUserId).toBe(2);
    expect(order.claimedAt).not.toBeNull();
  });

  it("T1.2: Feature 2 - Update Contact Information (WHATSAPP_SENT with notes persistence)", async () => {
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });

    const result = await updateOnlineOrderContact(
      {
        id: orderId,
        contactStatus: "WHATSAPP_SENT",
        contactNotes: "تم إرسال رسالة واتساب لتأكيد العنوان وموعد التسليم",
        scopedBranchId: null,
      },
      STAFF1_ACTOR,
    );

    expect(result.success).toBe(true);
    expect(result.contactStatus).toBe("WHATSAPP_SENT");

    const order = await getOrder(orderId);
    expect(order.contactStatus).toBe("WHATSAPP_SENT");
    expect(order.contactNotes).toBe("تم إرسال رسالة واتساب لتأكيد العنوان وموعد التسليم");
    expect(order.claimedByUserId).toBe(2);
  });

  it("T1.3: Feature 3 - Telephone Confirmation (CALLED_CONFIRMED auto-promotes PENDING to CONFIRMED)", async () => {
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });

    const result = await updateOnlineOrderContact(
      {
        id: orderId,
        contactStatus: "CALLED_CONFIRMED",
        contactNotes: "تم الاتصال بالزبون وأكد الرغبة في استلام الطلب غداً ظهراً",
        scopedBranchId: null,
      },
      STAFF1_ACTOR,
    );

    expect(result.success).toBe(true);

    const order = await getOrder(orderId);
    expect(order.status).toBe("CONFIRMED");
    expect(order.contactStatus).toBe("CALLED_CONFIRMED");
    expect(order.claimedByUserId).toBe(2);
  });

  it("T1.4: Feature 4 - Mark Order Prepared (CONFIRMED -> PROCESSING with SLA duration calculation)", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const { orderId } = await seedOnlineOrder({
      status: "CONFIRMED",
      claimedByUserId: 2,
      claimedAt: tenMinutesAgo,
    });

    const result = await markOnlineOrderPrepared({ id: orderId, scopedBranchId: null }, STAFF1_ACTOR);

    expect(result.success).toBe(true);
    expect(result.durationMinutes).toBe(10);
    expect(result.status).toBe("PROCESSING");

    const order = await getOrder(orderId);
    expect(order.status).toBe("PROCESSING");
    expect(order.preparedByUserId).toBe(2);
    expect(order.preparedAt).not.toBeNull();
    expect(order.fulfillmentDurationMinutes).toBe(10);
  });

  it("T1.5: Feature 5 - Dispatch to Courier (COD Sales Invoice + Consignment + SHIPPED status)", async () => {
    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
    });

    const result = await dispatchOnlineOrder(
      {
        onlineOrderId: orderId,
        partyId: 2,
        externalTrackingRef: "TRK-IQ-9988",
        notes: "تسليم سريع بعد الظهر",
      },
      ADMIN_ACTOR,
    );

    expect(result.orderId).toBe(orderId);
    expect(result.invoiceId).toBeGreaterThan(0);
    expect(result.consignmentId).toBeGreaterThan(0);
    expect(result.partyId).toBe(2);
    expect(result.total).toBe("5000.00");

    const order = await getOrder(orderId);
    expect(order.status).toBe("SHIPPED");
    expect(order.invoiceId).toBe(result.invoiceId);
    expect(order.deliveryPartyId).toBe(2);

    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, result.invoiceId)).limit(1)
    )[0];
    expect(invoice.sourceType).toBe("ONLINE");
    expect(invoice.paymentMode).toBe("COD");
    expect(invoice.status).toBe("PENDING");

    const consignment = (
      await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, result.consignmentId!)).limit(1)
    )[0];
    expect(consignment.partyId).toBe(2);
    expect(consignment.invoiceId).toBe(result.invoiceId);
    expect(consignment.sourceType).toBe("ONLINE_ORDER");
    expect(consignment.sourceId).toBe(orderId);
    expect(consignment.status).toBe("DISPATCHED");
    expect(consignment.externalTrackingRef).toBe("TRK-IQ-9988");
  });

  it("T1.6: Feature 6 - Warehouse Inventory Deduction (Base unit stock reduction and INVOICE movement)", async () => {
    const initialStock = await getVariantStock(1);
    expect(initialStock).toBe(100);

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
          unitPrice: "2500.00",
          total: "12500.00",
        },
      ],
    });

    const result = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const postStock = await getVariantStock(1);
    expect(postStock).toBe(95);

    const movements = await db()
      .select()
      .from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.referenceId, result.invoiceId), eq(s.inventoryMovements.referenceType, "INVOICE")));

    expect(movements).toHaveLength(1);
    expect(movements[0].variantId).toBe(1);
    expect(movements[0].movementType).toBe("OUT");
    expect(Number(movements[0].quantity)).toBe(5);
  });

  it("T1.7: Feature 7 - 24-Hour Stock Reservation Sweeper (Cancels expired orders with designated reason)", async () => {
    const expiredDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { orderId: expiredId } = await seedOnlineOrder({
      status: "PENDING",
      orderDate: expiredDate,
      reservationExpiresAt: new Date(Date.now() - 60 * 1000),
    });

    const futureDate = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const { orderId: activeId } = await seedOnlineOrder({
      status: "PENDING",
      reservationExpiresAt: futureDate,
    });

    const sweepResult = await sweepExpiredOnlineOrdersOnce(new Date());
    expect(sweepResult.cancelled).toBeGreaterThanOrEqual(1);

    const expiredOrder = await getOrder(expiredId);
    expect(expiredOrder.status).toBe("CANCELLED");
    expect(expiredOrder.cancelReason).toContain("انتهت مهلة حجز المخزون (24 ساعة)");

    const activeOrder = await getOrder(activeId);
    expect(activeOrder.status).toBe("PENDING");
  });
});

// =========================================================================================
// TIER 2: BOUNDARY & CORNER CASES (LIMITS, CONCURRENCY, & INVALID TRANSITIONS)
// =========================================================================================
describe("Tier 2: Boundary & Corner Cases (Limits, Concurrency, & Invalid Transitions)", () => {
  it("T2.1: Concurrency Race Condition — Simultaneous claims serialized via for update (1 winner, 1 CONFLICT)", async () => {
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });

    const results = await Promise.allSettled([
      claimOnlineOrder({ id: orderId, scopedBranchId: null }, STAFF1_ACTOR),
      claimOnlineOrder({ id: orderId, scopedBranchId: null }, STAFF2_ACTOR),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winningClaim = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect([2, 3]).toContain(winningClaim.claimedByUserId);

    const losingRejection = (rejected[0] as PromiseRejectedResult).reason;
    expect(losingRejection).toMatchObject({ code: "CONFLICT" });

    const order = await getOrder(orderId);
    expect(order.status).toBe("CONFIRMED");
    expect(order.claimedByUserId).toBe(winningClaim.claimedByUserId);
  });

  it("T2.2: 24-Hour Expiration Boundary — Orders expired by 1ms rejected on claim, confirm, and phone call", async () => {
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id = ${orderId}
    `);

    // 1. claimOnlineOrder must reject
    await expect(
      claimOnlineOrder({ id: orderId, scopedBranchId: null }, STAFF1_ACTOR),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 2. setOnlineOrderStatus to CONFIRMED must reject
    await expect(
      setOnlineOrderStatus({ id: orderId, status: "CONFIRMED", scopedBranchId: null }, 1),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 3. updateOnlineOrderContact with CALLED_CONFIRMED must reject
    await expect(
      updateOnlineOrderContact(
        { id: orderId, contactStatus: "CALLED_CONFIRMED", scopedBranchId: null },
        STAFF1_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const order = await getOrder(orderId);
    expect(order.status).toBe("PENDING");
  });

  it("T2.3: Illegal State Transitions — Rejection of invalid leaps (PENDING->SHIPPED, DELIVERED->PROCESSING)", async () => {
    const { orderId: pendingId } = await seedOnlineOrder({ status: "PENDING" });

    // Direct jump PENDING -> SHIPPED is illegal (dispatchOnlineOrder is the sole gateway)
    await expect(
      setOnlineOrderStatus({ id: pendingId, status: "SHIPPED", scopedBranchId: null }, 1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { orderId: deliveredId } = await seedOnlineOrder({ status: "DELIVERED" });

    // DELIVERED is a terminal state, cannot jump back to PROCESSING
    await expect(
      setOnlineOrderStatus({ id: deliveredId, status: "PROCESSING", scopedBranchId: null }, 1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { orderId: cancelledId } = await seedOnlineOrder({ status: "CANCELLED" });

    // CANCELLED is a terminal state, cannot jump to CONFIRMED
    await expect(
      setOnlineOrderStatus({ id: cancelledId, status: "CONFIRMED", scopedBranchId: null }, 1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("T2.4: Terminal State Immutability — CANCELLED and DELIVERED reject all operational updates", async () => {
    const { orderId: cancelledId } = await seedOnlineOrder({ status: "CANCELLED" });

    await expect(
      claimOnlineOrder({ id: cancelledId, scopedBranchId: null }, STAFF1_ACTOR),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      markOnlineOrderPrepared({ id: cancelledId, scopedBranchId: null }, STAFF1_ACTOR),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      updateOnlineOrderContact({ id: cancelledId, contactStatus: "WHATSAPP_SENT", scopedBranchId: null }, STAFF1_ACTOR),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      dispatchOnlineOrder({ onlineOrderId: cancelledId, partyId: 1 }, ADMIN_ACTOR),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { orderId: deliveredId } = await seedOnlineOrder({ status: "DELIVERED" });

    await expect(
      claimOnlineOrder({ id: deliveredId, scopedBranchId: null }, STAFF1_ACTOR),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      markOnlineOrderPrepared({ id: deliveredId, scopedBranchId: null }, STAFF1_ACTOR),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("T2.5: SLA Duration Minimum Boundary Clamp — Ultra-fast preparation clamped to 1 minute", async () => {
    const threeSecondsAgo = new Date(Date.now() - 3 * 1000);
    const { orderId } = await seedOnlineOrder({
      status: "CONFIRMED",
      claimedByUserId: 2,
      claimedAt: threeSecondsAgo,
    });

    const result = await markOnlineOrderPrepared({ id: orderId, scopedBranchId: null }, STAFF1_ACTOR);

    expect(result.success).toBe(true);
    expect(result.durationMinutes).toBe(1);

    const order = await getOrder(orderId);
    expect(order.fulfillmentDurationMinutes).toBe(1);
  });

  it("T2.6: Post-Invoicing Cancellation Lock Barrier — Reject cancellation once invoice is generated", async () => {
    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
    });

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    expect(dispatchRes.invoiceId).toBeGreaterThan(0);

    // Attempting to cancel an already invoiced order must be rejected
    await expect(
      setOnlineOrderStatus({ id: orderId, status: "CANCELLED", scopedBranchId: null }, 1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const order = await getOrder(orderId);
    expect(order.status).toBe("SHIPPED");
  });

  it("T2.7: Idempotent Self-Claiming & Inter-Staff Claim Lockout — Repeat claims safe, rival claims blocked", async () => {
    const originalClaimedAt = new Date(Math.floor((Date.now() - 15 * 60 * 1000) / 1000) * 1000);
    const { orderId } = await seedOnlineOrder({
      status: "CONFIRMED",
      claimedByUserId: 2,
      claimedAt: originalClaimedAt,
    });

    // 1. Staff 1 re-claims own order: idempotent, keeps original timestamp
    const selfClaim = await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF1_ACTOR);
    expect(selfClaim.success).toBe(true);

    const afterSelfClaim = await getOrder(orderId);
    expect(afterSelfClaim.claimedByUserId).toBe(2);
    expect(Math.floor(new Date(afterSelfClaim.claimedAt!).getTime() / 1000)).toBe(
      Math.floor(originalClaimedAt.getTime() / 1000),
    );

    // 2. Staff 2 attempts to claim order claimed by Staff 1: CONFLICT
    await expect(
      claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF2_ACTOR),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 3. Manager intervenes and reassigns: Allowed
    const managerClaim = await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, MANAGER_ACTOR);
    expect(managerClaim.success).toBe(true);
    expect(managerClaim.claimedByUserId).toBe(4);

    const afterManager = await getOrder(orderId);
    expect(afterManager.claimedByUserId).toBe(4);
  });

  it("T2.8: Company Courier Tracking Reference Guard — Strict requirement for COMPANY delivery parties", async () => {
    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
    });

    // Dispatching to Party 2 (COMPANY) WITHOUT tracking ref must throw BAD_REQUEST
    await expect(
      dispatchOnlineOrder(
        { onlineOrderId: orderId, partyId: 2, externalTrackingRef: null },
        ADMIN_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Dispatching to Party 2 (COMPANY) WITH tracking ref succeeds
    const successRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 2, externalTrackingRef: "DHL-BAGHDAD-8841" },
      ADMIN_ACTOR,
    );
    expect(successRes.invoiceId).toBeGreaterThan(0);
    expect((await getOrder(orderId)).status).toBe("SHIPPED");
  });
});

// =========================================================================================
// TIER 3: CROSS-FEATURE INTERACTIONS & MULTI-STEP COMBINATIONS
// =========================================================================================
describe("Tier 3: Cross-Feature Interactions & Multi-Step Combinations", () => {
  it("T3.1: Pipeline Attribution Precedence — Preparer (preparedByUserId) supersedes Claimer (claimedByUserId) for commission", async () => {
    // Staff 1 claims order
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });
    await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF1_ACTOR);

    const orderAfterClaim = await getOrder(orderId);
    expect(orderAfterClaim.claimedByUserId).toBe(2);

    // Manager marks order prepared (elevated can prepare another staff member's order)
    await markOnlineOrderPrepared({ id: orderId, scopedBranchId: 1 }, MANAGER_ACTOR);

    const orderAfterPrep = await getOrder(orderId);
    expect(orderAfterPrep.claimedByUserId).toBe(2);
    expect(orderAfterPrep.preparedByUserId).toBe(4);

    // Admin executes dispatch
    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    // Verify Financial Attribution Contract:
    // preparedByUserId (Manager 4) takes precedence over claimedByUserId (Staff 2) and dispatch actor (Admin 1)
    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];

    expect(invoice.createdBy).toBe(4);
    expect(invoice.salespersonNameSnapshot).toBe("مدير الفرع");

    // Check accountingEntries for attribution
    const accountingEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, dispatchRes.invoiceId));

    expect(accountingEntries.length).toBeGreaterThan(0);
    const saleEntry = accountingEntries.find((e) => e.entryType === "SALE");
    expect(saleEntry).toBeDefined();
    expect(saleEntry!.createdBy).toBe(4);
  });

  it("T3.2: Direct Dispatch Attribution Fallback — Unprepared orders attribute commission to claimedByUserId", async () => {
    // Staff 1 claims order, but order is dispatched without a separate markPrepared step
    const { orderId } = await seedOnlineOrder({ status: "PENDING" });
    await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF1_ACTOR);

    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];

    // Fallback to claimedByUserId (Staff 1 = 2)
    expect(invoice.createdBy).toBe(2);
    expect(invoice.salespersonNameSnapshot).toBe("موظف التجهيز 1");
  });

  it("T3.3: Courier Dispatch Idempotency Barrier — Re-dispatching returns existing invoice & consignment safely", async () => {
    const { orderId } = await seedOnlineOrder({
      status: "PROCESSING",
      claimedByUserId: 2,
      preparedByUserId: 2,
    });

    const stockBefore = await getVariantStock(1);

    // First dispatch
    const firstDispatch = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    const stockAfterFirst = await getVariantStock(1);
    expect(stockAfterFirst).toBe(stockBefore - 2);

    // Second dispatch (re-run)
    const secondDispatch = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    expect(secondDispatch.alreadyDispatched).toBe(true);
    expect(secondDispatch.invoiceId).toBe(firstDispatch.invoiceId);
    expect(secondDispatch.invoiceNumber).toBe(firstDispatch.invoiceNumber);

    // Crucial Invariant: Stock must NOT be deducted a second time
    const stockAfterSecond = await getVariantStock(1);
    expect(stockAfterSecond).toBe(stockAfterFirst);

    // Crucial Invariant: No duplicate invoice created
    const invoices = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.sourceId, `online-dispatch:${orderId}`));
    expect(invoices).toHaveLength(1);
  });

  it("T3.4: Active Reservation Sweeper Immunity — Confirmed & Processing orders protected from sweeper", async () => {
    const pastDate = new Date(Date.now() - 30 * 60 * 60 * 1000);

    // Confirmed order created 30h ago
    const { orderId: confirmedId } = await seedOnlineOrder({
      status: "CONFIRMED",
      orderDate: pastDate,
      reservationExpiresAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    // Processing order created 30h ago
    const { orderId: processingId } = await seedOnlineOrder({
      status: "PROCESSING",
      orderDate: pastDate,
      reservationExpiresAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    // Expired pending order created 30h ago
    const { orderId: expiredPendingId } = await seedOnlineOrder({
      status: "PENDING",
      orderDate: pastDate,
      reservationExpiresAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await sweepExpiredOnlineOrdersOnce(new Date());

    // Only PENDING is cancelled
    expect((await getOrder(expiredPendingId)).status).toBe("CANCELLED");
    // CONFIRMED and PROCESSING are immune
    expect((await getOrder(confirmedId)).status).toBe("CONFIRMED");
    expect((await getOrder(processingId)).status).toBe("PROCESSING");
  });

  it("T3.5: Multi-Item Complex Order Allocation & ATP Exemption — Multi-line orders deduct inventory cleanly", async () => {
    const stockV1Before = await getVariantStock(1);
    const stockV2Before = await getVariantStock(2);

    const { orderId } = await seedOnlineOrder({
      status: "CONFIRMED",
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "4",
          baseQuantity: 4,
          unitPrice: "2500.00",
          total: "10000.00",
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

    expect(dispatchRes.invoiceId).toBeGreaterThan(0);

    const stockV1After = await getVariantStock(1);
    const stockV2After = await getVariantStock(2);

    expect(stockV1After).toBe(stockV1Before - 4);
    expect(stockV2After).toBe(stockV2Before - 10);

    const invoiceLines = await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, dispatchRes.invoiceId));

    expect(invoiceLines).toHaveLength(2);
    expect(invoiceLines.map((l) => Number(l.variantId)).sort()).toEqual([1, 2]);
  });
});

// =========================================================================================
// TIER 4: REAL-WORLD SCENARIOS (COMPREHENSIVE END-TO-END OPERATIONAL LIFECYCLE)
// =========================================================================================
describe("Tier 4: Real-World Scenarios (Comprehensive End-to-End Operational Lifecycle)", () => {
  it("T4.1: Complete Customer Store Order Lifecycle — Web Order -> WhatsApp -> Confirm -> Prep -> Dispatch -> Ledger Verification", async () => {
    // 1. Initial State: Customer places order on storefront
    const { orderId } = await seedOnlineOrder({
      status: "PENDING",
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "2",
          baseQuantity: 2,
          unitPrice: "2500.00",
          total: "5000.00",
        },
      ],
      shippingCost: "5000.00",
    });

    expect((await getOrder(orderId)).status).toBe("PENDING");

    // 2. Staff claims the incoming order
    const claimRes = await claimOnlineOrder({ id: orderId, scopedBranchId: 1 }, STAFF1_ACTOR);
    expect(claimRes.success).toBe(true);
    expect((await getOrder(orderId)).status).toBe("CONFIRMED");

    // 3. Staff logs WhatsApp communication with the customer
    const contactRes = await updateOnlineOrderContact(
      {
        id: orderId,
        contactStatus: "WHATSAPP_SENT",
        contactNotes: "مرحبا أخي أحمد، تم استلام طلبك رقم الدفتر الجامعي. سنقوم بتجهيزه وشحنه اليوم.",
        scopedBranchId: 1,
      },
      STAFF1_ACTOR,
    );
    expect(contactRes.success).toBe(true);

    // 4. Staff logs telephone confirmation
    const callRes = await updateOnlineOrderContact(
      {
        id: orderId,
        contactStatus: "CALLED_CONFIRMED",
        contactNotes: "تم الاتصال بالزبون وأكد العنوان: حي المنصور قرب جامع الرحمن.",
        scopedBranchId: 1,
      },
      STAFF1_ACTOR,
    );
    expect(callRes.success).toBe(true);

    // 5. Staff finishes warehouse picking & packing, marks order prepared
    const prepRes = await markOnlineOrderPrepared({ id: orderId, scopedBranchId: 1 }, STAFF1_ACTOR);
    expect(prepRes.success).toBe(true);
    expect((await getOrder(orderId)).status).toBe("PROCESSING");

    // 6. Courier dispatch: Dispatched to courier company (Party 2 with tracking ref)
    const initialWarehouseStock = await getVariantStock(1);
    const dispatchRes = await dispatchOnlineOrder(
      {
        onlineOrderId: orderId,
        partyId: 2,
        externalTrackingRef: "NOOR-EXPRESS-10492",
        deliveryAddress: "حي المنصور، بغداد - قرب جامع الرحمن",
        notes: "الدفع نقداً عند الاستلام",
      },
      ADMIN_ACTOR,
    );

    // 7. Comprehensive Invariant Auditing:
    // A. Online Order Record
    const finalOrder = await getOrder(orderId);
    expect(finalOrder.status).toBe("SHIPPED");
    expect(finalOrder.invoiceId).toBe(dispatchRes.invoiceId);
    expect(finalOrder.deliveryPartyId).toBe(2);
    expect(finalOrder.preparedByUserId).toBe(2);
    expect(finalOrder.shippingAddress).toContain("حي المنصور");

    // B. Invoice Record & Payment Mode
    const finalInvoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1)
    )[0];
    expect(finalInvoice.sourceType).toBe("ONLINE");
    expect(finalInvoice.paymentMode).toBe("COD");
    expect(finalInvoice.status).toBe("PENDING");
    expect(finalInvoice.createdBy).toBe(2); // Fulfiller Staff 1
    expect(finalInvoice.salespersonNameSnapshot).toBe("موظف التجهيز 1");

    // C. Physical Inventory Stock Movement
    const finalWarehouseStock = await getVariantStock(1);
    expect(finalWarehouseStock).toBe(initialWarehouseStock - 2);

    // D. Courier Delivery Consignment
    const consignment = (
      await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, dispatchRes.consignmentId!)).limit(1)
    )[0];
    expect(consignment.status).toBe("DISPATCHED");
    expect(consignment.externalTrackingRef).toBe("NOOR-EXPRESS-10492");
    expect(consignment.sourceType).toBe("ONLINE_ORDER");
    expect(consignment.sourceId).toBe(orderId);

    // E. Financial Ledger Entries (Double-Sided Accounting)
    const ledgerEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.invoiceId, dispatchRes.invoiceId));

    expect(ledgerEntries.length).toBeGreaterThan(0);
    const saleEntry = ledgerEntries.find((e) => e.entryType === "SALE");
    expect(saleEntry).toBeDefined();
    expect(saleEntry!.revenue).toBe("5000.00"); // 2 * 2500
    expect(saleEntry!.cost).toBe("2000.00"); // 2 * 1000
    expect(saleEntry!.profit).toBe("3000.00"); // 5000 - 2000
  });

  it("T4.2: High-Volume Concurrent Multi-Staff Store Order Processing — Parallel processing across 3 staff members", async () => {
    // Seed 4 orders concurrently
    const [o1, o2, o3, o4] = await Promise.all([
      seedOnlineOrder({ status: "PENDING" }),
      seedOnlineOrder({ status: "PENDING" }),
      seedOnlineOrder({ status: "PENDING" }),
      seedOnlineOrder({ status: "PENDING" }),
    ]);

    // Staff 1 claims Order 1 & 2
    // Staff 2 claims Order 3
    // Manager claims Order 4
    await Promise.all([
      claimOnlineOrder({ id: o1.orderId, scopedBranchId: 1 }, STAFF1_ACTOR),
      claimOnlineOrder({ id: o2.orderId, scopedBranchId: 1 }, STAFF1_ACTOR),
      claimOnlineOrder({ id: o3.orderId, scopedBranchId: 1 }, STAFF2_ACTOR),
      claimOnlineOrder({ id: o4.orderId, scopedBranchId: 1 }, MANAGER_ACTOR),
    ]);

    expect((await getOrder(o1.orderId)).claimedByUserId).toBe(2);
    expect((await getOrder(o2.orderId)).claimedByUserId).toBe(2);
    expect((await getOrder(o3.orderId)).claimedByUserId).toBe(3);
    expect((await getOrder(o4.orderId)).claimedByUserId).toBe(4);

    // Prepare orders
    await Promise.all([
      markOnlineOrderPrepared({ id: o1.orderId, scopedBranchId: 1 }, STAFF1_ACTOR),
      markOnlineOrderPrepared({ id: o2.orderId, scopedBranchId: 1 }, STAFF1_ACTOR),
      markOnlineOrderPrepared({ id: o3.orderId, scopedBranchId: 1 }, STAFF2_ACTOR),
      markOnlineOrderPrepared({ id: o4.orderId, scopedBranchId: 1 }, MANAGER_ACTOR),
    ]);

    // Dispatch all 4 orders to individual courier (Party 1)
    const dispatches = await Promise.all([
      dispatchOnlineOrder({ onlineOrderId: o1.orderId, partyId: 1 }, ADMIN_ACTOR),
      dispatchOnlineOrder({ onlineOrderId: o2.orderId, partyId: 1 }, ADMIN_ACTOR),
      dispatchOnlineOrder({ onlineOrderId: o3.orderId, partyId: 1 }, ADMIN_ACTOR),
      dispatchOnlineOrder({ onlineOrderId: o4.orderId, partyId: 1 }, ADMIN_ACTOR),
    ]);

    // Verify all 4 reached SHIPPED
    for (const d of dispatches) {
      expect(d.invoiceId).toBeGreaterThan(0);
      const o = await getOrder(d.orderId);
      expect(o.status).toBe("SHIPPED");
    }

    // Verify attributions on invoices
    const inv1 = (await db().select().from(s.invoices).where(eq(s.invoices.id, dispatches[0].invoiceId)).limit(1))[0];
    const inv2 = (await db().select().from(s.invoices).where(eq(s.invoices.id, dispatches[1].invoiceId)).limit(1))[0];
    const inv3 = (await db().select().from(s.invoices).where(eq(s.invoices.id, dispatches[2].invoiceId)).limit(1))[0];
    const inv4 = (await db().select().from(s.invoices).where(eq(s.invoices.id, dispatches[3].invoiceId)).limit(1))[0];

    expect(inv1.createdBy).toBe(2);
    expect(inv2.createdBy).toBe(2);
    expect(inv3.createdBy).toBe(3);
    expect(inv4.createdBy).toBe(4);
  });

  it("T4.3: Edge Recovery & Self-Healing — Dispatched invoice reversal handling on cancelled order", async () => {
    const { orderId } = await seedOnlineOrder({
      status: "CONFIRMED",
      claimedByUserId: 2,
    });

    // Dispatch successfully to individual courier (Party 1)
    const dispatchRes = await dispatchOnlineOrder(
      { onlineOrderId: orderId, partyId: 1 },
      ADMIN_ACTOR,
    );

    expect(dispatchRes.invoiceId).toBeGreaterThan(0);

    // If order was somehow forcibly updated to CANCELLED in database (e.g. disaster recovery / manual admin DB script)
    await db().update(s.onlineOrders).set({ status: "CANCELLED" }).where(eq(s.onlineOrders.id, orderId));

    // Calling dispatchOnlineOrder on this cancelled order triggers self-healing / reversal
    await expect(
      dispatchOnlineOrder({ onlineOrderId: orderId, partyId: 1 }, ADMIN_ACTOR),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The orphan invoice should be safely returned
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, dispatchRes.invoiceId)).limit(1))[0];
    expect(inv.status).toBe("RETURNED");
  });
});
