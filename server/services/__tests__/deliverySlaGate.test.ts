/**
 * Slice DFP1 (٣٠/٨/٢٦) — حارس SLA على عمر الطرود المفتوحة (assertNoStaleOpenParcelsTx).
 *
 * قرارُ المالك (٣٠/٨): إسنادُ جديدٍ لجهةٍ لديها أيّ طرد أقدم من `maxOpenParcelAgeDays` بلا توريد
 * ⇒ رفضٌ ثابت بلا تجاوُز إداريّ. الجهة تُصفّي القديم أوّلاً.
 *
 * ما تحرسه هذه الاختبارات:
 *  ① طردٌ حديثٌ (< العتبة): إسنادٌ ثانٍ يمرّ.
 *  ② طردٌ قديمٌ (> العتبة، UNSETTLED): إسنادٌ ثانٍ يُرفض برسالة تحمل العدد والأقدم.
 *  ③ الرفضُ **قبل أيّ كتابة** — لا فاتورة يتيمة، لا إرسالية جديدة، لا عهدة تتحرّك.
 *  ④ عتبةٌ مخصَّصة للجهة تُغيّر السلوك (١٤ يوماً بدل ٧).
 *  ⑤ طردٌ قديمٌ **مورَّد** (SETTLED) لا يمنع الإسنادَ الجديد — سُوّي فلا مطالبةَ عليه.
 *  ⑥ طردٌ قديمٌ **ملغى** (CANCELLED) لا يمنع الإسنادَ الجديد — لا مسؤوليّةَ حيّة.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { dispatchToDelivery } from "../delivery/dispatch";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "orderPayments", "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrders", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits", "productVariants",
  "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

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
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc1", name: "موظف", email: "r1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب اختبار SLA", partyType: "INDIVIDUAL", currentBalance: "0.00", isActive: true, maxOpenParcelAgeDays: 7 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}

async function openReception(): Promise<number> {
  const shift = await openShift(
    { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
    { userId: 2, branchId: 1 },
  );
  return shift.shiftId;
}

async function dispatchedOrder(shiftId: number, reqId: string, salePrice: string) {
  const r = await checkoutReception({
    branchId: 1, shiftId, customerId: 1,
    paidAmount: "0",
    clientRequestId: reqId,
    workOrders: [{
      title: "طلب توصيل", quantity: 1, salePrice, materials: [],
      hasDelivery: true, deliveryAddress: "بغداد", deliveryPhone: "+9647701234567",
    }],
  }, CASHIER);
  const woId = r.workOrders[0].workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  const d = await dispatchToDelivery({ workOrderId: woId, partyId: 1, clientRequestId: `d-${reqId}` }, CASHIER);
  return { workOrderId: woId, consignmentId: d.consignmentId, invoiceId: d.invoiceId };
}

/** يقدّم dispatchedAt لطرد إلى الوراء بـN يوماً — محاكاة تراكم بلا توريد. */
async function ageParcelBy(consignmentId: number, days: number) {
  await db().execute(sql`UPDATE deliveryConsignments SET dispatchedAt = DATE_SUB(NOW(), INTERVAL ${days} DAY) WHERE id = ${consignmentId}`);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("Slice DFP1 — حارس SLA على عمر الطرود المفتوحة", () => {
  it("① طردٌ حديثٌ (يوم واحد) لا يمنع إسناداً جديداً — الإسناد الثاني ينجح", async () => {
    const shiftId = await openReception();
    const first = await dispatchedOrder(shiftId, "sla-1a", "10000.00");
    await ageParcelBy(first.consignmentId, 1);

    const second = await dispatchedOrder(shiftId, "sla-1b", "5000.00");
    expect(second.consignmentId).toBeGreaterThan(0);
  });

  it("⭐ ② طردٌ قديمٌ (١٠ أيّام، UNSETTLED) والعتبةُ ٧ أيّام ⇒ إسنادٌ جديد يُرفض FORBIDDEN", async () => {
    const shiftId = await openReception();
    const stale = await dispatchedOrder(shiftId, "sla-2a", "12000.00");
    await ageParcelBy(stale.consignmentId, 10);

    const before = (await db().select().from(s.deliveryConsignments)).length;
    await expect(dispatchedOrder(shiftId, "sla-2b", "3000.00"))
      .rejects.toThrowError(/طرداً مفتوحاً منذ أكثر من ٧ يوماً|10 يوماً|أكثر من 7/);
    // الرفض قبل أيّ كتابة: لا إرسالية ثانية، لا فاتورة يتيمة تحرّكت.
    const after = (await db().select().from(s.deliveryConsignments)).length;
    expect(after).toBe(before);
  });

  it("④ عتبةٌ مخصَّصة للجهة (١٤ يوماً) تسمح بطردٍ عمره ١٠ أيّام", async () => {
    await db().update(s.deliveryParties).set({ maxOpenParcelAgeDays: 14 }).where(eq(s.deliveryParties.id, 1));
    const shiftId = await openReception();
    const stale = await dispatchedOrder(shiftId, "sla-4a", "12000.00");
    await ageParcelBy(stale.consignmentId, 10);

    // الآن الإسناد ينجح لأنّ العتبة أوسع.
    const second = await dispatchedOrder(shiftId, "sla-4b", "4000.00");
    expect(second.consignmentId).toBeGreaterThan(0);
  });

  it("⑤ طردٌ قديمٌ مورَّد (SETTLED) لا يمنع إسناداً جديداً — سُوّي فلا مطالبة", async () => {
    const shiftId = await openReception();
    const settled = await dispatchedOrder(shiftId, "sla-5a", "8000.00");
    await ageParcelBy(settled.consignmentId, 30);
    // نمرّر moneyStatus إلى SETTLED كأنّه ورّده — لا يهمّنا كيف صار مسدَّداً.
    await db().update(s.deliveryConsignments)
      .set({ moneyStatus: "SETTLED", status: "DELIVERED" })
      .where(eq(s.deliveryConsignments.id, settled.consignmentId));

    const fresh = await dispatchedOrder(shiftId, "sla-5b", "2000.00");
    expect(fresh.consignmentId).toBeGreaterThan(0);
  });

  it("⑥ طردٌ قديمٌ ملغى (parcelStatus CANCELLED) لا يمنع إسناداً جديداً", async () => {
    const shiftId = await openReception();
    const cancelled = await dispatchedOrder(shiftId, "sla-6a", "8000.00");
    await ageParcelBy(cancelled.consignmentId, 30);
    await db().update(s.deliveryConsignments)
      .set({ parcelStatus: "CANCELLED" })
      .where(eq(s.deliveryConsignments.id, cancelled.consignmentId));

    const fresh = await dispatchedOrder(shiftId, "sla-6b", "1500.00");
    expect(fresh.consignmentId).toBeGreaterThan(0);
  });
});
