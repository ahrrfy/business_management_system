/**
 * اختبارات قناة الموظف المستندية لتقدّم الطرد (staffTransition):
 *  - خروج جماعي: ينقل المؤهَّل (ومن ASSIGNED مباشرةً — القفزة المقصودة) ويكتب أحداثاً
 *    بنفس أسماء أحداث البوّابة، ويتخطّى المستثنيات بأسبابها بلا throw.
 *  - لا يدهس سائقاً مُسنَداً — يملأ الشاغر فقط.
 *  - عزل الفرع: غير الأدمن محصور بفرعه (تخطٍّ في الدفعة، FORBIDDEN في المفرد).
 *  - الفشل الموظفي يرفض المحصَّل جزئياً/المسدَّد بالكاونتر ويوجّه للكشف، وidempotent.
 *  - مرآة الأحداث: eventType والأعمدة المكتوبة = ما تكتبه البوّابة حرفياً؛ التمييز في payload.source.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { createWorkOrder } from "../workOrderService";
import {
  createDeliveryParty,
  dispatchToDelivery,
  transitionConsignmentParcel,
} from "../deliveryService";
import {
  staffHandoverConsignments,
  staffMarkFailed,
} from "../delivery/staffTransition";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderMaterials", "workOrderImages", "workOrders",
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

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
/** كاشير فرعٍ آخر — لعزل الفرع. */
const OTHER_BRANCH_CASHIER = { userId: 2, branchId: 2, role: "cashier" };
const ADMIN = { userId: 1, branchId: 2, role: "admin" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_cashier", name: "كاشير", email: "c@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_courier", name: "مندوب", email: "d@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "local_courier2", name: "مندوب ٢", email: "d2@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل التوصيل", phone: "+9647700000000" }]);
  await d.insert(s.products).values([{ id: 1, name: "كتاب مطبوع" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "BK-1", costPrice: "0.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  // جهتان: فرد مربوط بحساب (البوّابة تعمل عليه) + شركة بيانات بلا حساب — جوهرُ الحملة:
  // إرسالياتها تُنشَأ بلا assignedUserId ولا أحدَ يملك بوّابةً يُقدّمها منها.
  const { id: partyInd } = await createDeliveryParty(
    { partyType: "INDIVIDUAL", name: "مندوب", defaultFee: "1500", userId: 3, branchId: 1 },
    MANAGER,
  );
  const { id: partyCo } = await createDeliveryParty(
    { partyType: "COMPANY", name: "شركة توصيل بلا حساب", defaultFee: "2000", branchId: 1 },
    MANAGER,
  );
  return { partyInd, partyCo };
}

/** ينشئ طلب توصيل READY (بلا عربون — المال ليس موضوع هذه القناة). */
async function readyWorkOrder(): Promise<number> {
  const wo = await createWorkOrder(
    {
      branchId: 1,
      customerId: 1,
      baseVariantId: 1,
      title: "طباعة",
      salePrice: "10000",
      quantity: 1,
      deposit: "0",
      paymentMethod: "CASH",
      hasDelivery: true,
      deliveryAddress: "بغداد",
      deliveryFeeCollection: "COURIER",
    },
    { userId: 2, branchId: 1 },
  );
  const woId = (wo as { workOrderId: number }).workOrderId;
  await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
  return woId;
}

async function dispatchCn(partyId: number): Promise<number> {
  const woId = await readyWorkOrder();
  const disp = await dispatchToDelivery({ workOrderId: woId, partyId }, CASHIER);
  return disp.consignmentId;
}

async function cnRow(id: number) {
  return (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)).limit(1))[0];
}

async function eventsFor(consignmentId: number, eventType?: string) {
  const conds = [eq(s.deliveryEvents.consignmentId, consignmentId)];
  if (eventType) conds.push(eq(s.deliveryEvents.eventType, eventType));
  return db().select().from(s.deliveryEvents).where(and(...conds));
}

/** يُقدّم الطرد عبر البوّابة (المندوب user 3) حتى الحالة المطلوبة. */
async function gateAdvance(consignmentId: number, upTo: "ACCEPTED" | "PICKED_UP" | "OUT_FOR_DELIVERY") {
  const seqAll = ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;
  const seq = seqAll.slice(0, seqAll.indexOf(upTo) + 1);
  for (const toStatus of seq) {
    await transitionConsignmentParcel(
      { consignmentId, toStatus, clientRequestId: `gate-${consignmentId}-${toStatus}` },
      { userId: 3 },
    );
  }
}

describe("delivery staff transitions — قناة الموظف المستندية", () => {
  beforeEach(async () => {
    await reset();
  });

  it("خروج جماعي: ينقل من ASSIGNED وPICKED_UP، يكتب أحداث البوّابة نفسها، ويتخطّى المستثنيات بأسبابها — وإعادةُ الدفعة بلا تكرار", async () => {
    const { partyInd } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const a = await dispatchCn(partyInd); // ASSIGNED — القفزة المباشرة المقصودة
    const b = await dispatchCn(partyInd);
    await gateAdvance(b, "PICKED_UP");
    const c = await dispatchCn(partyInd);
    await gateAdvance(c, "OUT_FOR_DELIVERY"); // خارج فعلاً
    const d = await dispatchCn(partyInd);
    await db().update(s.deliveryConsignments)
      .set({ returnDeclaredAt: new Date(), returnDeclaredBy: 1, returnDeclaredReason: "رفض العميل" })
      .where(eq(s.deliveryConsignments.id, d)); // رجوع مُعلَن

    const res = await staffHandoverConsignments(
      { consignmentIds: [a, b, c, d, 999999], clientRequestId: "ho-1" },
      CASHIER,
    );
    expect(res.moved).toBe(2);
    expect(res.skipped).toHaveLength(3);
    expect(res.skipped.find((x) => x.consignmentId === c)?.reason).toMatch(/خارج فعلاً/);
    expect(res.skipped.find((x) => x.consignmentId === d)?.reason).toMatch(/رجوع/);
    expect(res.skipped.find((x) => x.consignmentId === 999999)?.reason).toMatch(/غير موجودة/);

    for (const id of [a, b]) {
      const cn = await cnRow(id);
      expect(cn.parcelStatus).toBe("OUT_FOR_DELIVERY");
      expect(cn.outForDeliveryAt).not.toBeNull();
    }
    // الرجوع المُعلَن لم يُمَسّ.
    expect((await cnRow(d)).parcelStatus).toBe("ASSIGNED");

    // الحدث بنفس اسم حدث البوّابة، من الحالة الحقيقية، بمصدر السلطة في payload.
    const evA = await eventsFor(a, "OUT_FOR_DELIVERY");
    expect(evA).toHaveLength(1);
    expect(evA[0].eventKey).toBe(`CN:${a}:STAFF_OUT:ho-1`);
    expect(evA[0].fromParcelStatus).toBe("ASSIGNED");
    expect(evA[0].toParcelStatus).toBe("OUT_FOR_DELIVERY");
    expect(evA[0].actorUserId).toBe(2);
    expect((evA[0].payload as { source?: string }).source).toBe("STAFF_HANDOVER");
    expect((await eventsFor(b, "OUT_FOR_DELIVERY"))[0].fromParcelStatus).toBe("PICKED_UP");
    // صفّ outbox رافق الحدث بنفس topic البوّابة.
    const outbox = await db().select().from(s.deliveryOutbox).where(eq(s.deliveryOutbox.topic, "delivery.out_for_delivery"));
    expect(outbox.length).toBeGreaterThanOrEqual(2);

    // إعادة نفس الدفعة: صفر نقل، «خارج فعلاً»، وبلا حدثٍ ثانٍ (idempotent بالتصميم).
    const retry = await staffHandoverConsignments(
      { consignmentIds: [a, b, c, d, 999999], clientRequestId: "ho-1" },
      CASHIER,
    );
    expect(retry.moved).toBe(0);
    expect(retry.skipped.find((x) => x.consignmentId === a)?.reason).toMatch(/خارج فعلاً/);
    expect(await eventsFor(a, "OUT_FOR_DELIVERY")).toHaveLength(1);
    expect(await eventsFor(b, "OUT_FOR_DELIVERY")).toHaveLength(1);
  });

  it("لا يدهس سائقاً مُسنَداً — ويملأ الشاغر فقط (إرسالية شركة بلا حساب)", async () => {
    const { partyInd, partyCo } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const vacant = await dispatchCn(partyCo); // شركة بلا حساب ⇒ assignedUserId=NULL
    const owned = await dispatchCn(partyInd); // فرد ⇒ أُسند تلقائياً للمستخدم 3
    expect((await cnRow(vacant)).assignedUserId).toBeNull();
    expect((await cnRow(owned)).assignedUserId).toBe(3);

    const res = await staffHandoverConsignments(
      { consignmentIds: [vacant, owned], assignedUserId: 4, clientRequestId: "ho-drv" },
      CASHIER,
    );
    expect(res.moved).toBe(2);
    expect((await cnRow(vacant)).assignedUserId).toBe(4); // الشاغر امتلأ
    expect((await cnRow(owned)).assignedUserId).toBe(3); // المُسنَد لم يُدَس
  });

  it("عزل الفرع: كاشير فرعٍ آخر يُتخطّى له الطرد، والأدمن يعبر الفروع", async () => {
    const { partyInd } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const a = await dispatchCn(partyInd);

    const denied = await staffHandoverConsignments(
      { consignmentIds: [a], clientRequestId: "ho-b2" },
      OTHER_BRANCH_CASHIER,
    );
    expect(denied.moved).toBe(0);
    expect(denied.skipped[0]?.reason).toMatch(/فرع/);
    expect((await cnRow(a)).parcelStatus).toBe("ASSIGNED");
    // والمفرد يرفض صراحةً لا تخطّياً.
    await expect(
      staffMarkFailed({ consignmentId: a, reason: "بلاغ جهة", clientRequestId: "mf-b2" }, OTHER_BRANCH_CASHIER),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const allowed = await staffHandoverConsignments(
      { consignmentIds: [a], clientRequestId: "ho-adm" },
      ADMIN,
    );
    expect(allowed.moved).toBe(1);
    expect((await cnRow(a)).parcelStatus).toBe("OUT_FOR_DELIVERY");
  });

  it("فشل موظفي: يوسم النظيف (حتى من OUT_FOR_DELIVERY) بنفس أعمدة البوّابة، idempotent، ويرفض المحصَّل والمسدَّد بالكاونتر برسالة توجّه للكشف", async () => {
    const { partyInd } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const clean = await dispatchCn(partyInd);
    await staffHandoverConsignments({ consignmentIds: [clean], clientRequestId: "ho-f" }, CASHIER);

    const r1 = await staffMarkFailed(
      { consignmentId: clean, reason: "الزبون لا يرد على الهاتف", clientRequestId: "mf-1" },
      CASHIER,
    );
    expect(r1.replay).toBe(false);
    const cn = await cnRow(clean);
    expect(cn.parcelStatus).toBe("FAILED");
    expect(cn.failedAt).not.toBeNull();
    expect(cn.failureReason).toBe("الزبون لا يرد على الهاتف"); // نفس عمود البوّابة حرفياً
    const ev = await eventsFor(clean, "FAILED");
    expect(ev).toHaveLength(1);
    expect(ev[0].fromParcelStatus).toBe("OUT_FOR_DELIVERY");
    expect((ev[0].payload as { source?: string; reason?: string })).toMatchObject({
      source: "STAFF",
      reason: "الزبون لا يرد على الهاتف",
    });

    // إعادة نفس الطلب ⇒ replay بلا حدثٍ ثانٍ.
    const r2 = await staffMarkFailed(
      { consignmentId: clean, reason: "الزبون لا يرد على الهاتف", clientRequestId: "mf-1" },
      CASHIER,
    );
    expect(r2.replay).toBe(true);
    expect(await eventsFor(clean, "FAILED")).toHaveLength(1);

    // محصَّل جزئياً ⇒ يُرفَض والتوجيه للكشف.
    const collected = await dispatchCn(partyInd);
    await db().update(s.deliveryConsignments)
      .set({ collectedAmount: "3000.00" })
      .where(eq(s.deliveryConsignments.id, collected));
    await expect(
      staffMarkFailed({ consignmentId: collected, reason: "بلاغ الجهة", clientRequestId: "mf-2" }, CASHIER),
    ).rejects.toThrow(/كشف الشركة/);
    expect((await cnRow(collected)).parcelStatus).toBe("ASSIGNED"); // لم يُمَسّ

    // مسدَّد بالكاونتر بعد ثبوت التسليم ⇒ يُرفَض كذلك.
    const settled = await dispatchCn(partyInd);
    await db().update(s.deliveryConsignments)
      .set({ counterSettledAmount: "2000.00" })
      .where(eq(s.deliveryConsignments.id, settled));
    await expect(
      staffMarkFailed({ consignmentId: settled, reason: "بلاغ الجهة", clientRequestId: "mf-3" }, CASHIER),
    ).rejects.toThrow(/بالكاونتر/);

    // سببٌ أقصر من حرفين ⇒ نفس رسالة البوّابة.
    const another = await dispatchCn(partyInd);
    await expect(
      staffMarkFailed({ consignmentId: another, reason: " ", clientRequestId: "mf-4" }, CASHIER),
    ).rejects.toThrow(/سبب تعذر التوصيل/);
    // ورجوعٌ مُعلَن ⇒ لا وسم فوقه.
    await db().update(s.deliveryConsignments)
      .set({ returnDeclaredAt: new Date(), returnDeclaredBy: 1 })
      .where(eq(s.deliveryConsignments.id, another));
    await expect(
      staffMarkFailed({ consignmentId: another, reason: "بلاغ الجهة", clientRequestId: "mf-5" }, CASHIER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("مرآة الأحداث: eventType الموظف = eventType البوّابة حرفياً للانتقالَين، والتمييز في payload.source فقط", async () => {
    const { partyInd } = await seed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });

    // OUT_FOR_DELIVERY: بوّابة على g، موظف على h.
    const g = await dispatchCn(partyInd);
    await gateAdvance(g, "OUT_FOR_DELIVERY");
    const h = await dispatchCn(partyInd);
    await staffHandoverConsignments({ consignmentIds: [h], clientRequestId: "mirror-out" }, CASHIER);
    const gateOut = (await eventsFor(g)).find((e) => e.toParcelStatus === "OUT_FOR_DELIVERY");
    const staffOut = (await eventsFor(h)).find((e) => e.toParcelStatus === "OUT_FOR_DELIVERY");
    expect(gateOut && staffOut).toBeTruthy();
    expect(staffOut!.eventType).toBe(gateOut!.eventType);
    expect((staffOut!.payload as { source?: string }).source).toBe("STAFF_HANDOVER");

    // FAILED: بوّابة على g (من OUT_FOR_DELIVERY)، موظف على h.
    await transitionConsignmentParcel(
      { consignmentId: g, toStatus: "FAILED", reason: "عنوان خاطئ", clientRequestId: "gate-fail" },
      { userId: 3 },
    );
    await staffMarkFailed({ consignmentId: h, reason: "عنوان خاطئ", clientRequestId: "staff-fail" }, CASHIER);
    const gateFail = (await eventsFor(g)).find((e) => e.toParcelStatus === "FAILED");
    const staffFail = (await eventsFor(h)).find((e) => e.toParcelStatus === "FAILED");
    expect(staffFail!.eventType).toBe(gateFail!.eventType);
    // وكلا القناتين كتبتا نفس عمود السبب.
    expect((await cnRow(g)).failureReason).toBe("عنوان خاطئ");
    expect((await cnRow(h)).failureReason).toBe("عنوان خاطئ");
    expect((staffFail!.payload as { source?: string }).source).toBe("STAFF");
  });
});
