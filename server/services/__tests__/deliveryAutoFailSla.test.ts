/**
 * م١ (PR-4) — أتمتة ١: تعذّرٌ بانقضاء SLA (`staleSweep.autoFailStaleParcels`).
 *
 * ما تحرسه:
 *  ① العلَم مطفأ (الافتراض) ⇒ لا شيء يتغيّر مهما تقادم الطرد.
 *  ② العلَم مفتوح: طردٌ تجاوز `maxOpenParcelAgeDays` بلا قبض ⇒ FAILED + حدث `AUTO_FAILED_SLA`
 *     (بدليل العمر والعتبة) + مهمّةُ متابعةٍ للمالك مربوطةً بالفاتورة؛ والدورةُ التالية لا تكرّره.
 *  ③ لا يُوسَم: طردٌ حديث، أو أُعلن رجوعُه، أو قُبض منه شيءٌ في الدفتر.
 *  ④ السقفُ اليوميّ يوقف الدفعة ويُبلغ بما تُرك.
 *  ⑤ التراجع: إعادةُ الإسناد FAILED→ASSIGNED القائمة تعمل بعد الوسم الآليّ — لا مالَ يُعكَس.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../sale/create";
import { AUTO_FAILED_SLA_EVENT, autoFailStaleParcels, dailyAutoFailCap, MAX_AUTO_FAILS_PER_DAY_DEFAULT, sweepStaleConsignments } from "../delivery/staleSweep";
import { reassignDeliveryConsignment } from "../delivery/parties";
import { declareConsignmentReturn } from "../delivery/declaredReturn";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines",
  "deliveryRemittances", "deliveryConsignments", "deliveryPartyMembers", "deliveryParties",
  "taskEvents", "tasks", "notificationOccurrences",
  "idempotencyKeys", "auditLogs", "accountingEntries", "receipts",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const OWNER_ID = 3;
const PARTY = 1;
const OTHER_PARTY = 2;
const FLAG = "ROLLOUT_DELIVERY_AUTO_FAIL_SLA";
const CAP_ENV = "DELIVERY_MAX_AUTO_FAILS_PER_DAY";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) {
    try {
      await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
    } catch {
      /* جدولٌ غائب في هذه الشجرة — التنظيف الشامل في __setup__ يكفي */
    }
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "csh", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: OWNER_ID, openId: "own", name: "المالك", email: "o@t.test", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", phone: "+9647701234567", currentBalance: "0.00", creditLimit: null }]);
  await d.insert(s.deliveryParties).values([
    { id: PARTY, name: "مندوب", partyType: "INDIVIDUAL", branchId: 1, currentBalance: "0.00", isActive: true, defaultFee: "1500.00", maxOpenParcelAgeDays: 7 },
    { id: OTHER_PARTY, name: "مندوب بديل", partyType: "INDIVIDUAL", branchId: 1, currentBalance: "0.00", isActive: true, defaultFee: "1500.00", maxOpenParcelAgeDays: 7 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 500 }]);
}
async function saleWithDelivery(reqId: string) {
  const r = await createSale({
    branchId: 1, sourceType: "POS", customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
    delivery: { partyId: PARTY, fee: "1500", feeCollection: "COURIER", recipientPhone: "07701234567", address: "بغداد" },
    clientRequestId: reqId,
  }, CASHIER);
  return { invoiceId: r.invoiceId, consignmentId: r.consignmentId! };
}
async function ageParcel(consignmentId: number, days: number) {
  await db().execute(sql`UPDATE deliveryConsignments SET dispatchedAt = DATE_SUB(NOW(), INTERVAL ${days} DAY) WHERE id = ${consignmentId}`);
}
const consignmentOf = async (id: number) =>
  (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)))[0];
const eventsOf = async (id: number) =>
  db().select().from(s.deliveryEvents).where(eq(s.deliveryEvents.consignmentId, id));

beforeEach(async () => {
  await reset();
  await seed();
  delete process.env[FLAG];
  delete process.env[CAP_ENV];
});
afterEach(() => {
  delete process.env[FLAG];
  delete process.env[CAP_ENV];
});

describe("autoFailStaleParcels — تعذّرٌ بانقضاء SLA خلف علَم", () => {
  it("العلَم مطفأ (الافتراض) ⇒ لا وسم مهما تقادم الطرد", async () => {
    const a = await saleWithDelivery("af-off");
    await ageParcel(a.consignmentId, 10);
    const res = await autoFailStaleParcels();
    expect(res).toEqual({ failed: 0, skippedByDailyCap: 0, skippedDuplicates: 0 });
    expect((await consignmentOf(a.consignmentId)).parcelStatus).toBe("ASSIGNED");
  });

  it("⭐ العلَم مفتوح: الطرد المتقادم بلا قبض يُوسَم FAILED بحدثٍ يحمل الدليل ومهمّةٍ للمالك، ولا يتكرّر", async () => {
    process.env[FLAG] = "ON";
    const a = await saleWithDelivery("af-on");
    await ageParcel(a.consignmentId, 10);

    const res = await autoFailStaleParcels();
    expect(res.failed).toBe(1);
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.parcelStatus).toBe("FAILED");
    expect(cn.status).toBe("DISPATCHED"); // الإغلاق الماليّ لم يتغيّر — لا مالَ تحرّك
    expect(cn.failedAt).toBeTruthy();
    expect(cn.failureReason).toMatch(/تجاوز مهلة التوصيل/);
    const ev = (await eventsOf(a.consignmentId)).find((e) => e.eventType === AUTO_FAILED_SLA_EVENT);
    expect(ev).toBeTruthy();
    expect(ev!.fromParcelStatus).toBe("ASSIGNED");
    expect(ev!.toParcelStatus).toBe("FAILED");
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload.authority).toBe("SYSTEM_SLA_SWEEP");
    expect(payload.thresholdDays).toBe(7);
    expect(Number(payload.ageDays)).toBeGreaterThanOrEqual(10);
    const task = (await db().select().from(s.tasks))[0];
    expect(task).toBeTruthy();
    expect(Number(task.linkedInvoiceId)).toBe(a.invoiceId);
    expect(Number(task.assignedTo)).toBe(OWNER_ID);
    expect(task.title).toContain(cn.consignmentNumber);
    // لا عهدةَ ولا دفترَ تحرّك: الوسمُ تشغيليّ.
    expect((await db().select().from(s.deliveryLedgerEntries)).map((e) => e.entryType)).toEqual(["COD_ASSIGNED"]);

    // الدورة التالية (ومن الكنّاس العامّ) لا تُعيد الوسم ولا تفتح مهمّةً ثانية.
    const again = await sweepStaleConsignments();
    expect(again.autoFailed).toBe(0);
    expect((await db().select().from(s.tasks)).length).toBe(1);
  });

  it("لا يُوسَم: طردٌ حديث، أو أُعلن رجوعُه، أو قُبض منه شيءٌ في الدفتر", async () => {
    process.env[FLAG] = "ON";
    // الإسنادُ كلُّه أوّلاً ثمّ التقادم: حارسُ SLA على الإسناد (DFP1، `assertNoStaleOpenParcelsTx`)
    // يرفض إسناداً جديداً لجهةٍ لديها طردٌ متأخّر — حتى المُعلَنُ رجوعُه يبقى مفتوحاً حتى يصل.
    const fresh = await saleWithDelivery("af-fresh");
    const declared = await saleWithDelivery("af-declared");
    const collected = await saleWithDelivery("af-collected");
    await ageParcel(fresh.consignmentId, 3);
    await ageParcel(declared.consignmentId, 12);
    await declareConsignmentReturn({ consignmentId: declared.consignmentId, reason: "رفض العميل", clientRequestId: "decl-1" }, MANAGER);
    await ageParcel(collected.consignmentId, 12);
    await db().insert(s.deliveryLedgerEntries).values({
      eventKey: `CN:${collected.consignmentId}:COD_COLLECTED:TEST`, partyId: PARTY, consignmentId: collected.consignmentId,
      branchId: 1, entryType: "COD_COLLECTED", amount: "500.00",
    });

    const res = await autoFailStaleParcels();
    expect(res.failed).toBe(0);
    for (const id of [fresh.consignmentId, declared.consignmentId, collected.consignmentId]) {
      expect((await consignmentOf(id)).parcelStatus).toBe("ASSIGNED");
    }
  });

  it("السقفُ الافتراضيّ يسري حين يغيب متغيّر البيئة أو يكون فارغاً (كان الفارغُ يُقرأ صفراً فيُطفئ الأتمتة صامتاً)", async () => {
    expect(dailyAutoFailCap()).toBe(MAX_AUTO_FAILS_PER_DAY_DEFAULT);
    process.env[CAP_ENV] = "";
    expect(dailyAutoFailCap()).toBe(MAX_AUTO_FAILS_PER_DAY_DEFAULT);
    process.env[CAP_ENV] = "abc";
    expect(dailyAutoFailCap()).toBe(MAX_AUTO_FAILS_PER_DAY_DEFAULT);
    process.env[CAP_ENV] = "0";
    expect(dailyAutoFailCap()).toBe(0); // الصفرُ الصريح وحده يعني «لا وسمَ اليوم»
    process.env[CAP_ENV] = "7";
    expect(dailyAutoFailCap()).toBe(7);

    process.env[FLAG] = "ON";
    process.env[CAP_ENV] = "";
    const a = await saleWithDelivery("af-envempty");
    await ageParcel(a.consignmentId, 10);
    expect(await autoFailStaleParcels()).toMatchObject({ failed: 1, skippedByDailyCap: 0 });
  });

  it("السقفُ اليوميّ يوقف الدفعة ويُبلغ بما تُرك", async () => {
    process.env[FLAG] = "ON";
    const a = await saleWithDelivery("af-cap-1");
    const b = await saleWithDelivery("af-cap-2");
    await ageParcel(a.consignmentId, 10);
    await ageParcel(b.consignmentId, 10);
    const res = await autoFailStaleParcels({ maxPerDay: 1 });
    expect(res.failed).toBe(1);
    expect(res.skippedByDailyCap).toBe(1);
    // السقفُ يُحسب على ما وُسم اليوم فعلاً: الدورة التالية بنفس السقف لا تُضيف شيئاً.
    const next = await autoFailStaleParcels({ maxPerDay: 1 });
    expect(next.failed).toBe(0);
    expect(next.skippedByDailyCap).toBe(1);
  });

  it("التراجع: إعادةُ الإسناد FAILED→ASSIGNED القائمة تعمل بعد الوسم الآليّ", async () => {
    process.env[FLAG] = "ON";
    const a = await saleWithDelivery("af-rollback");
    await ageParcel(a.consignmentId, 10);
    await autoFailStaleParcels();
    expect((await consignmentOf(a.consignmentId)).parcelStatus).toBe("FAILED");
    // إعادةُ الإسناد القائمة تعمل داخل الجهة نفسها (محاولةٌ ثانية/سائقٌ آخر) — تُصفّر أثر التعذّر.
    await reassignDeliveryConsignment(
      { consignmentId: a.consignmentId, partyId: PARTY, clientRequestId: "reassign-after-auto-fail" },
      MANAGER,
    );
    const cn = await consignmentOf(a.consignmentId);
    expect(cn.parcelStatus).toBe("ASSIGNED");
    expect(cn.failedAt).toBeNull();
    expect(cn.failureReason).toBeNull();
    // الوسمُ الآليّ لا يتكرّر على طردٍ أُعيد إسناده (الحدث الواحد لكلّ طرد يمنعه) — الحسمُ صار بيد الموظّف.
    expect((await autoFailStaleParcels()).failed).toBe(0);
  });
});
