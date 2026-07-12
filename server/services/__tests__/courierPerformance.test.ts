/**
 * اختبارات تقرير أداء المناديب — عدّ/قيمة تشغيلية لطلبات المتجر المُسنَدة لكل جهة توصيل.
 *
 * يتحقّق من: تجميع المُسنَد/المُسلَّم/قيد التوصيل/المتعذّر + قيمة المُسلَّم + COD المُحصَّل + معدّل التعذّر
 * + العهدة القائمة (لقطة)، مع عزل الفرع وفلترة الفترة، وتمييز «المتعذّر» (CANCELLED بسبب) عن إلغاءٍ
 * بلا سبب. البيانات تُهيَّأ عبر المسارات الحقيقية (createSale + confirmCourierDelivery + failCourierDelivery).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { confirmCourierDelivery, createDeliveryParty, failCourierDelivery } from "../deliveryService";
import { getCourierPerformance } from "../reports/courierPerformance";

const MANAGER = { userId: 1, branchId: 1, role: "manager" };

const TABLES = [
  "idempotencyKeys", "creditApprovals", "accountingEntries", "receipts",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "onlineOrderItems", "onlineOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "cr1", name: "مندوب أ", email: "c1@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "cr2", name: "مندوب ب", email: "c2@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "6.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "زبون متجر", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  const { id: partyA } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "جهة أ", userId: 3, branchId: 1 }, MANAGER);
  const { id: partyB } = await createDeliveryParty({ partyType: "COMPANY", name: "جهة ب", userId: 4, branchId: 1 }, MANAGER);
  return { partyA, partyB };
}

/** يُهيّئ طلب متجر SHIPPED (فاتورة ONLINE على ذمّة العميل + طلب مُسنَد للمندوب). يعيد {orderId, invoiceId, total}. */
async function shippedOrder(qty: number, orderNumber: string, partyId: number, branchId = 1): Promise<{ orderId: number; invoiceId: number; total: string }> {
  const d = db();
  const sale = await createSale(
    { branchId, customerId: 1, sourceType: "ONLINE", priceTier: "RETAIL", lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }] },
    { ...MANAGER, branchId },
  );
  const total = (qty * 10).toFixed(2);
  await d.insert(s.onlineOrders).values({
    orderNumber, customerId: 1, branchId,
    subtotal: total, shippingCost: "0", taxAmount: "0", total,
    status: "SHIPPED", invoiceId: sale.invoiceId, deliveryPartyId: partyId,
    shippingAddress: "بغداد", governorate: "baghdad",
  });
  const orderId = Number((await d.select({ id: s.onlineOrders.id }).from(s.onlineOrders).where(eq(s.onlineOrders.orderNumber, orderNumber)).limit(1))[0].id);
  return { orderId, invoiceId: sale.invoiceId, total };
}

async function seedParties(): Promise<{ partyA: number; partyB: number }> {
  const d = db();
  const a = (await d.select({ id: s.deliveryParties.id }).from(s.deliveryParties).where(eq(s.deliveryParties.userId, 3)).limit(1))[0];
  const b = (await d.select({ id: s.deliveryParties.id }).from(s.deliveryParties).where(eq(s.deliveryParties.userId, 4)).limit(1))[0];
  return { partyA: Number(a.id), partyB: Number(b.id) };
}

function rowOf(res: Awaited<ReturnType<typeof getCourierPerformance>>, partyId: number) {
  const r = res.rows.find((x) => x.partyId === partyId);
  if (!r) throw new Error(`no row for party ${partyId}`);
  return r;
}

describe("تقرير أداء المناديب", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("يجمّع المُسلَّم/المتعذّر/قيد التوصيل + قيمة + COD + معدّل التعذّر + العهدة", async () => {
    const { partyA, partyB } = await seedParties();
    const o1 = await shippedOrder(2, "ORD-P1", partyA); // 20
    const o2 = await shippedOrder(3, "ORD-P2", partyA); // 30
    const o3 = await shippedOrder(1, "ORD-P3", partyA); // 10
    await shippedOrder(1, "ORD-P4", partyB); // 10 — يبقى SHIPPED (قيد التوصيل)

    // المندوب أ: يسلّم اثنين (20 + 30) ويتعذّر واحد (10).
    await confirmCourierDelivery({ onlineOrderId: o1.orderId }, { userId: 3 });
    await confirmCourierDelivery({ onlineOrderId: o2.orderId }, { userId: 3 });
    await failCourierDelivery({ onlineOrderId: o3.orderId, reason: "رفض الزبون الاستلام" }, { userId: 3 });

    const res = await getCourierPerformance({});
    const A = rowOf(res, partyA);
    expect(A.assigned).toBe(3);
    expect(A.delivered).toBe(2);
    expect(A.inTransit).toBe(0);
    expect(A.failed).toBe(1);
    expect(A.failRate).toBe("33.33"); // 1 ÷ (2+1)
    expect(A.deliveredValue).toBe("50.00");
    expect(A.codCollected).toBe("50.00"); // حُصِّل كامل عند التسليم
    expect(A.custodyOutstanding).toBe("50.00"); // عهدة المندوب (لم تُورَّد)

    const B = rowOf(res, partyB);
    expect(B.assigned).toBe(1);
    expect(B.delivered).toBe(0);
    expect(B.inTransit).toBe(1);
    expect(B.failed).toBe(0);
    expect(B.custodyOutstanding).toBe("0.00");

    // الترتيب: الأكثر تسليماً أولاً (أ قبل ب).
    expect(res.rows[0].partyId).toBe(partyA);

    // الإجماليات.
    expect(res.summary).toMatchObject({
      parties: 2, assigned: 4, delivered: 2, inTransit: 1, failed: 1,
      failRate: "33.33", deliveredValue: "50.00", codCollected: "50.00", custodyOutstanding: "50.00",
    });
  });

  it("«المتعذّر» يحتسب إلغاء المندوب (بسبب) لا الإلغاء بلا سبب", async () => {
    const { partyA } = await seedParties();
    const o1 = await shippedOrder(1, "ORD-Q1", partyA);
    const o2 = await shippedOrder(1, "ORD-Q2", partyA);
    // إلغاء «إداري» بلا سبب على طلبٍ مُسنَد (محاكاة حالة قديمة): CANCELLED + cancelReason NULL.
    await db().update(s.onlineOrders).set({ status: "CANCELLED", cancelReason: null }).where(eq(s.onlineOrders.id, o1.orderId));
    // تعذّر تسليم حقيقي (بسبب).
    await failCourierDelivery({ onlineOrderId: o2.orderId, reason: "عنوان خاطئ" }, { userId: 3 });

    const A = rowOf(await getCourierPerformance({}), partyA);
    expect(A.assigned).toBe(2);
    expect(A.failed).toBe(1); // فقط ذو السبب
  });

  it("فلترة الفترة: طلبٌ خارج النطاق لا يُحتسب", async () => {
    const { partyA } = await seedParties();
    const old = await shippedOrder(2, "ORD-OLD", partyA);
    await db().update(s.onlineOrders).set({ orderDate: new Date("2020-06-15T09:00:00Z") }).where(eq(s.onlineOrders.id, old.orderId));

    // نافذة تشمل الطلب المُثبَّت.
    const inWindow = await getCourierPerformance({ from: "2020-06-01", to: "2020-06-30" });
    expect(rowOf(inWindow, partyA).assigned).toBe(1);

    // نافذة لا تشمل شيئاً.
    const outWindow = await getCourierPerformance({ from: "2019-01-01", to: "2019-12-31" });
    expect(outWindow.rows).toHaveLength(0);
    expect(outWindow.summary.parties).toBe(0);
  });

  it("عزل الفرع: طلب فرعٍ آخر لا يُحتسب عند تحديد الفرع", async () => {
    const d = db();
    const { partyA } = await seedParties();
    await d.insert(s.branches).values({ id: 2, name: "SALES", code: "SALES", type: "SALES" });
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 2, quantity: 100 });
    await shippedOrder(1, "ORD-B1", partyA, 1); // فرع 1
    await shippedOrder(2, "ORD-B2", partyA, 2); // فرع 2

    const b1 = await getCourierPerformance({ branchId: 1 });
    expect(rowOf(b1, partyA).assigned).toBe(1);
    const b2 = await getCourierPerformance({ branchId: 2 });
    expect(rowOf(b2, partyA).assigned).toBe(1);
    const all = await getCourierPerformance({});
    expect(rowOf(all, partyA).assigned).toBe(2);
  });

  it("لا جهات مُسنَدة ⇒ نتيجة فارغة نظيفة", async () => {
    await seedParties();
    const res = await getCourierPerformance({});
    expect(res.rows).toHaveLength(0);
    expect(res.summary.parties).toBe(0);
    expect(res.summary.deliveredValue).toBe("0.00");
  });
});
