/**
 * Tier-2 #4 (٢٦/٨) — كاشفُ سلامة الربط بين طلب المتجر والإرسالية.
 *
 * الحالات المُثبَتة هنا (بعد مراجعة Codex على PR #823):
 *   1) طلبٌ SHIPPED/DELIVERED بلا إرسالية — مُقيَّدٌ بـcutover env (بلا env: لا كاشف).
 *   2) طلب DELIVERED × إرسالية ≠ DELIVERED.
 *   3) طلب CANCELLED × إرسالية غير طرفيّة (Terminal = DELIVERED/RETURNED/CANCELLED).
 *   3-عكسي) إرسالية DELIVERED/CANCELLED/RETURNED × طلب لا يزال قبل-طرفيّ.
 *   4) تعارض جهة التوصيل.
 * + حالاتٌ سلبيّة نظيفة (لا انحراف).
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { reconcileOnlineOrderConsignmentSync } from "../reconcileService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryConsignments",
  "deliveryPartyMembers", "deliveryParties",
  "onlineOrderItems", "onlineOrders",
  "invoiceItems", "invoices", "customers", "branches", "users",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "عميل متجر", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "جهة أ", partyKind: "INDIVIDUAL", currentBalance: "0.00", isActive: true },
    { id: 2, name: "جهة ب", partyKind: "INDIVIDUAL", currentBalance: "0.00", isActive: true },
  ]);
}

async function makeOrder(
  n: number,
  status: "PENDING" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED",
  extra: { deliveryPartyId?: number; invoiceId?: number } = {},
): Promise<number> {
  const [res] = await db().insert(s.onlineOrders).values({
    orderNumber: `ORD-${n}`,
    customerId: 1,
    branchId: 1,
    invoiceId: extra.invoiceId ?? null,
    subtotal: "10.00", shippingCost: "0.00", taxAmount: "0.00", total: "10.00",
    status,
    deliveryPartyId: extra.deliveryPartyId ?? null,
    clientRequestId: `req-${n}`,
  });
  return Number((res as { insertId: number }).insertId);
}

async function makeInvoice(n: number): Promise<number> {
  const [res] = await db().insert(s.invoices).values({
    invoiceNumber: `INV-${n}`,
    branchId: 1,
    customerId: 1,
    subtotal: "10.00", total: "10.00", paidAmount: "0.00", returnedTotal: "0.00",
    createdBy: 1,
  });
  return Number((res as { insertId: number }).insertId);
}

async function makeConsignment(
  n: number,
  orderId: number,
  invoiceId: number,
  partyId: number,
  parcelStatus: "ASSIGNED" | "DELIVERED" | "CANCELLED" | "RETURNED",
): Promise<number> {
  const [res] = await db().insert(s.deliveryConsignments).values({
    consignmentNumber: `CN-${n}`,
    branchId: 1,
    partyId,
    invoiceId,
    sourceType: "ONLINE_ORDER",
    sourceId: orderId,
    codAmount: "10.00", collectedAmount: "0.00", counterSettledAmount: "0.00",
    deliveryFee: "0.00", feeCollection: "COURIER",
    parcelStatus,
    dispatchedAt: new Date(),
    dispatchedBy: 1,
  });
  return Number((res as { insertId: number }).insertId);
}

describe("reconcileOnlineOrderConsignmentSync", () => {
  beforeEach(async () => { await reset(); await seed(); });
  afterEach(() => { delete process.env.ONLINE_ORDER_CONSIGNMENT_REQUIRED_FROM; });

  it("طلبٌ PENDING بلا إرسالية ⇒ لا انحراف (السلوك الطبيعيّ)", async () => {
    await makeOrder(1, "PENDING");
    expect(await reconcileOnlineOrderConsignmentSync()).toEqual([]);
  });

  it("Codex P2 #3: SHIPPED بلا إرسالية بلا cutover ⇒ لا كاشف (fail-open للتاريخ القديم)", async () => {
    delete process.env.ONLINE_ORDER_CONSIGNMENT_REQUIRED_FROM;
    await makeOrder(2, "SHIPPED");
    expect(await reconcileOnlineOrderConsignmentSync()).toEqual([]);
  });

  it("SHIPPED بلا إرسالية بعد cutover ⇒ يُكشف؛ قبل cutover ⇒ يُتجاهَل", async () => {
    // cutover في المستقبل ⇒ الطلب المُنشَأ الآن < cutover ⇒ لا كاشف.
    process.env.ONLINE_ORDER_CONSIGNMENT_REQUIRED_FROM = "2099-01-01T00:00:00Z";
    await makeOrder(3, "SHIPPED");
    expect(await reconcileOnlineOrderConsignmentSync()).toEqual([]);
    // cutover في الماضي ⇒ الطلب الآن ≥ cutover ⇒ يُكشف.
    process.env.ONLINE_ORDER_CONSIGNMENT_REQUIRED_FROM = "2000-01-01T00:00:00Z";
    const issues = await reconcileOnlineOrderConsignmentSync();
    expect(issues.map((i) => i.entity)).toContain("orderShippedWithoutConsignment");
  });

  it("طلب DELIVERED مع إرسالية ASSIGNED ⇒ orderDeliveredConsignmentNotDelivered", async () => {
    const invoiceId = await makeInvoice(4);
    const orderId = await makeOrder(4, "DELIVERED", { invoiceId });
    await makeConsignment(4, orderId, invoiceId, 1, "ASSIGNED");
    const issues = await reconcileOnlineOrderConsignmentSync();
    expect(issues.map((i) => i.entity)).toContain("orderDeliveredConsignmentNotDelivered");
  });

  it("طلب CANCELLED مع إرسالية ASSIGNED ⇒ orderCancelledConsignmentLive", async () => {
    const invoiceId = await makeInvoice(5);
    const orderId = await makeOrder(5, "CANCELLED", { invoiceId });
    await makeConsignment(5, orderId, invoiceId, 1, "ASSIGNED");
    const issues = await reconcileOnlineOrderConsignmentSync();
    expect(issues.map((i) => i.entity)).toContain("orderCancelledConsignmentLive");
  });

  it("Codex P2 #4: CANCELLED × DELIVERED ⇒ لا انحراف (مسار إلغاء البيع بعد التسليم مدعوم)", async () => {
    const invoiceId = await makeInvoice(6);
    const orderId = await makeOrder(6, "CANCELLED", { invoiceId });
    // Terminal حسب `delivery/guards.ts` يشمل DELIVERED — إلغاء بيعٍ لاحقاً لا يُغيّر تاريخ الطرد.
    await makeConsignment(6, orderId, invoiceId, 1, "DELIVERED");
    expect(await reconcileOnlineOrderConsignmentSync()).toEqual([]);
  });

  it("طلب CANCELLED مع إرسالية RETURNED ⇒ لا انحراف (Terminal)", async () => {
    const invoiceId = await makeInvoice(7);
    const orderId = await makeOrder(7, "CANCELLED", { invoiceId });
    await makeConsignment(7, orderId, invoiceId, 1, "RETURNED");
    expect(await reconcileOnlineOrderConsignmentSync()).toEqual([]);
  });

  it("Codex P2 #5 (اتّجاه عكسيّ): إرسالية DELIVERED × طلب SHIPPED ⇒ consignmentDeliveredOrderNotDelivered", async () => {
    const invoiceId = await makeInvoice(8);
    const orderId = await makeOrder(8, "SHIPPED", { invoiceId });
    await makeConsignment(8, orderId, invoiceId, 1, "DELIVERED");
    const issues = await reconcileOnlineOrderConsignmentSync();
    expect(issues.map((i) => i.entity)).toContain("consignmentDeliveredOrderNotDelivered");
  });

  it("Codex P2 #5 (اتّجاه عكسيّ): إرسالية CANCELLED × طلب SHIPPED ⇒ consignmentTerminalOrderPreTerminal", async () => {
    const invoiceId = await makeInvoice(9);
    const orderId = await makeOrder(9, "SHIPPED", { invoiceId });
    await makeConsignment(9, orderId, invoiceId, 1, "CANCELLED");
    const issues = await reconcileOnlineOrderConsignmentSync();
    expect(issues.map((i) => i.entity)).toContain("consignmentTerminalOrderPreTerminal");
  });

  it("طلبٌ يذكر جهةً مخالفة لإرساليته ⇒ orderConsignmentPartyMismatch", async () => {
    const invoiceId = await makeInvoice(10);
    const orderId = await makeOrder(10, "SHIPPED", { invoiceId, deliveryPartyId: 1 });
    // إرسالية مُسنَدة لجهة أخرى (partyId=2) — تعارض إسنادٍ صريح.
    await makeConsignment(10, orderId, invoiceId, 2, "ASSIGNED");
    const issues = await reconcileOnlineOrderConsignmentSync();
    const pm = issues.find((i) => i.entity === "orderConsignmentPartyMismatch");
    expect(pm).toBeDefined();
    expect(pm?.expected).toBe("partyId=2");
    expect(pm?.actual).toBe("partyId=1");
  });

  it("طلب DELIVERED + إرسالية DELIVERED + party يطابق ⇒ لا انحراف", async () => {
    const invoiceId = await makeInvoice(11);
    const orderId = await makeOrder(11, "DELIVERED", { invoiceId, deliveryPartyId: 1 });
    await makeConsignment(11, orderId, invoiceId, 1, "DELIVERED");
    expect(await reconcileOnlineOrderConsignmentSync()).toEqual([]);
  });
});
