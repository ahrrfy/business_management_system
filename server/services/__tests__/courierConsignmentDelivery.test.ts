/**
 * اختبارات تسليم المندوب للإرساليات الموحدة (شاشة «توصيلاتي») — confirmConsignmentDelivery.
 *
 * الثابت المالي الحاكم: الإسناد يثبت التعرض فقط؛ ختم التسليم يغلق ذمّة العميل وينقل COD
 * إلى عهدة الجهة، ثم recordDeliveryRemittance ينقل العهدة إلى الدرج بلا تحصيل ثانٍ.
 * تشمل التغطية الفصل التشغيلي/المالي، العزل الذاتي (IDOR)، والشركات وidempotency.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { createWorkOrder } from "../workOrderService";
import {
  addDeliveryPartyMember,
  confirmConsignmentDelivery,
  createDeliveryParty,
  dispatchToDelivery,
  listReadyForDispatch,
  listMyDeliveries,
  recordDeliveryRemittance,
  reassignDeliveryConsignment,
  transitionConsignmentParcel,
} from "../deliveryService";
import { markWorkOrderReady, startWorkOrder } from "../workOrderService";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import {
  reconcileCustomerBalances,
  reconcileDeliveryFloat,
  reconcileLedgerProfit,
} from "../reconcileService";

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const OPERATOR = { userId: 5, branchId: 1, role: "print_operator" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts",
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "deliveryConsignments", "deliveryRemittances", "deliveryParties",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "workOrderDesignApprovals", "workOrderDesignRevisions", "taskEvents", "tasks",
  "workOrderMaterials", "workOrderImages", "workOrders", "serviceTypes",
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

/** يبذر الأساس + مندوبَين مرتبطَين بجهتين (userId 3→أ، 4→ب). يعيد partyIds. */
async function seedBase(): Promise<{ partyA: number; partyB: number }> {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "csh", name: "كاشير", email: "cash@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "cr1", name: "مندوب أ", email: "c1@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "cr2", name: "مندوب ب", email: "c2@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "op1", name: "فني طباعة", email: "op@t.test", role: "print_operator", loginMethod: "local", branchId: 1 },
    { id: 6, openId: "company_driver_1", name: "سائق الشركة أ", email: "d1@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 7, openId: "company_driver_2", name: "سائق الشركة ب", email: "d2@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 8, openId: "company_manager", name: "مدير شركة التوصيل", email: "dm@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    blocksExecution: true,
    isActive: true,
  });
  await d.insert(s.customers).values({ id: 1, name: "عميل التوصيل", phone: "+9647700000000" });
  await d.insert(s.products).values({ id: 1, name: "كتاب مطبوع" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "BK-1", costPrice: "0.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  const { id: partyA } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "جهة أ", userId: 3, branchId: 1 }, MANAGER);
  const { id: partyB } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "جهة ب", userId: 4, branchId: 1 }, MANAGER);
  return { partyA, partyB };
}

/** يمرّر الأمر في دورة الفني الحقيقية: RECEIVED → IN_PROGRESS → READY. */
async function readyReception(): Promise<number> {
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
      deliveryAddress: "بغداد - الكرادة",
      deliveryFeeCollection: "COURIER", // الأجرة يقبضها المندوب ⇒ لا صرف نقديّ عند الإرسال
      assignedTo: 5,
    },
    { userId: 2, branchId: 1 },
  );
  const woId = (wo as { workOrderId: number }).workOrderId;
  const approval = await requestWorkOrderDesignApproval({
    workOrderId: woId,
    requestKey: `courier-design-request:${randomUUID()}`,
    note: "اعتماد التصميم قبل بدء التنفيذ",
  }, CASHIER);
  await decideWorkOrderDesignApproval({
    approvalId: Number(approval.approval.id),
    decisionKey: `courier-design-approve:${randomUUID()}`,
    decision: "APPROVED",
    reason: "وافق العميل على التصميم النهائي",
    evidence: {
      type: "WHATSAPP_MESSAGE",
      reference: `wamid.courier.${randomUUID()}`,
    },
  }, MANAGER);
  await startWorkOrder(woId, OPERATOR);
  await markWorkOrderReady(woId, OPERATOR);
  return woId;
}

/** ينشئ أمراً جاهزاً عبر الفني ثم يرسله للجهة. codAmount = salePrice (بلا عربون). */
async function dispatchReception(partyId: number): Promise<{ consignmentId: number; invoiceId: number; codAmount: string }> {
  const woId = await readyReception();
  const disp = await dispatchToDelivery(
    { workOrderId: woId, partyId, deliveryFee: "0", recipientName: "زبون", recipientPhone: "07700000000", deliveryAddress: "بغداد" },
    CASHIER,
  );
  return { consignmentId: disp.consignmentId, invoiceId: disp.invoiceId, codAmount: disp.codAmount };
}

async function advanceToOutForDelivery(consignmentId: number, userId = 3) {
  for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
    await transitionConsignmentParcel(
      { consignmentId, toStatus, clientRequestId: `test-${consignmentId}-${toStatus}` },
      { userId },
    );
  }
}

async function consignment(id: number) {
  return (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)).limit(1))[0];
}
async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)).limit(1))[0];
}
async function partyBalance(id: number): Promise<string> {
  return String((await db().select({ b: s.deliveryParties.currentBalance }).from(s.deliveryParties).where(eq(s.deliveryParties.id, id)).limit(1))[0]?.b ?? "0");
}
async function entryCount(type?: string): Promise<number> {
  const q = db().select({ n: sql<number>`COUNT(*)` }).from(s.accountingEntries);
  const r = (await (type ? q.where(eq(s.accountingEntries.entryType, type as never)) : q))[0];
  return Number(r?.n ?? 0);
}
async function reconcileClean() {
  expect(await reconcileCustomerBalances()).toEqual([]);
  expect(await reconcileDeliveryFloat()).toEqual([]);
  expect(await reconcileLedgerProfit()).toEqual([]);
}

describe("courier «توصيلاتي» — تسليم إرسالية وتحويل COD إلى عهدة الجهة", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("ختم التسليم يغلق حالة الطرد والفاتورة وينقل COD إلى العهدة بلا إدخال نقد للدرج", async () => {
    const { partyA } = await seedParties();
    const disp = await dispatchReception(partyA); // codAmount 10000، عهدة 10000
    expect(disp.codAmount).toBe("10000.00");
    expect(await partyBalance(partyA)).toBe("0.00");
    await advanceToOutForDelivery(disp.consignmentId);

    const cnBefore = await consignment(disp.consignmentId);
    const invBefore = await invoice(disp.invoiceId);
    const entriesBefore = await entryCount();
    await reconcileClean();

    const res = await confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 3 });
    expect(res.consignmentId).toBe(disp.consignmentId);
    expect(res.deliveredAt).toBeInstanceOf(Date);

    const cnAfter = await consignment(disp.consignmentId);
    expect(cnAfter.parcelStatus).toBe("DELIVERED");
    expect(cnAfter.moneyStatus).toBe("UNSETTLED");
    expect(cnAfter.courierDeliveredAt).not.toBeNull();
    expect(cnAfter.status).toBe("DISPATCHED"); // المحور المالي يبقى مفتوحاً حتى التوريد
    expect(cnAfter.collectedAmount).toBe(cnBefore.collectedAmount); // "0.00"
    expect(cnAfter.remittanceId).toBeNull();
    expect(cnAfter.settledAt).toBeNull();
    expect(cnAfter.deliveryFee).toBe(cnBefore.deliveryFee);

    expect(await partyBalance(partyA)).toBe("10000.00"); // COD المحصّل صار بعهدة الجهة
    const invAfter = await invoice(disp.invoiceId);
    expect(invBefore.paidAmount).toBe("0.00");
    expect(invAfter.paidAmount).toBe("10000.00");
    expect(invAfter.status).toBe("PAID");
    expect(await entryCount()).toBe(entriesBefore + 2);
    await reconcileClean();
  });

  it("listMyDeliveries: الإرسالية في toDeliver ثم تنتقل لـdelivered بعد الختم", async () => {
    const { partyA } = await seedParties();
    const disp = await dispatchReception(partyA);

    const mine = await listMyDeliveries(3);
    expect(mine.linked).toBe(true);
    const before = mine.toDeliver.find((r) => r.kind === "consignment" && r.id === disp.consignmentId);
    expect(before).toBeTruthy();
    expect(before!.codDue).toBe("10000.00");
    expect(mine.delivered.some((r) => r.kind === "consignment" && r.id === disp.consignmentId)).toBe(false);

    await advanceToOutForDelivery(disp.consignmentId);
    await confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 3 });

    const mine2 = await listMyDeliveries(3);
    expect(mine2.toDeliver.some((r) => r.kind === "consignment" && r.id === disp.consignmentId)).toBe(false);
    expect(mine2.delivered.some((r) => r.kind === "consignment" && r.id === disp.consignmentId)).toBe(true);
  });

  it("رحلة الظهور الكاملة: جاهز من الفني → إدارة التوصيل → جهة أ فقط", async () => {
    const { partyA } = await seedParties();
    const woId = await readyReception();
    expect((await listReadyForDispatch(1)).some((r) => Number(r.id) === woId)).toBe(true);

    const disp = await dispatchToDelivery({ workOrderId: woId, partyId: partyA, deliveryFee: "0" }, CASHIER);
    expect((await listReadyForDispatch(1)).some((r) => Number(r.id) === woId)).toBe(false);
    const mineA = await listMyDeliveries(3);
    const mineB = await listMyDeliveries(4);
    expect(mineA.toDeliver.some((r) => r.kind === "consignment" && r.id === disp.consignmentId)).toBe(true);
    expect(mineB.toDeliver.some((r) => r.kind === "consignment" && r.id === disp.consignmentId)).toBe(false);
  });

  it("حساب الشركة: طابور مشترك ثم claim ذري وإعادة إسناد بعد التعذر", async () => {
    const company = await createDeliveryParty(
      { partyType: "COMPANY", name: "شركة التوصيل", userId: 8, branchId: 1 },
      MANAGER,
    );
    await addDeliveryPartyMember({ partyId: company.id, userId: 6, memberRole: "DRIVER" }, MANAGER);
    await addDeliveryPartyMember({ partyId: company.id, userId: 7, memberRole: "DRIVER" }, MANAGER);

    const woId = await readyReception();
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId: company.id, deliveryFee: "0" }, CASHIER);
    expect((await consignment(disp.consignmentId)).assignedUserId).toBeNull();
    expect((await listMyDeliveries(6)).toDeliver.some((r) => r.id === disp.consignmentId)).toBe(true);
    expect((await listMyDeliveries(7)).toDeliver.some((r) => r.id === disp.consignmentId)).toBe(true);
    expect((await listMyDeliveries(8)).toDeliver.some((r) => r.id === disp.consignmentId)).toBe(true);

    await transitionConsignmentParcel(
      { consignmentId: disp.consignmentId, toStatus: "ACCEPTED", clientRequestId: "company-driver-6-accept" },
      { userId: 6 },
    );
    expect((await consignment(disp.consignmentId)).assignedUserId).toBe(6);
    expect((await listMyDeliveries(7)).toDeliver.some((r) => r.id === disp.consignmentId)).toBe(false);
    await expect(
      transitionConsignmentParcel(
        { consignmentId: disp.consignmentId, toStatus: "PICKED_UP", clientRequestId: "company-driver-7-steal" },
        { userId: 7 },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await transitionConsignmentParcel(
      { consignmentId: disp.consignmentId, toStatus: "FAILED", reason: "العنوان مغلق", clientRequestId: "company-driver-6-failed" },
      { userId: 6 },
    );
    await reassignDeliveryConsignment(
      { partyId: company.id, consignmentId: disp.consignmentId, assignedUserId: 7, clientRequestId: "company-reassign-driver-7" },
      MANAGER,
    );
    expect((await listMyDeliveries(6)).toDeliver.some((r) => r.id === disp.consignmentId)).toBe(false);
    expect((await listMyDeliveries(7)).toDeliver.some((r) => r.id === disp.consignmentId)).toBe(true);
    expect((await listMyDeliveries(8)).toDeliver.some((r) => r.id === disp.consignmentId)).toBe(true);
  });

  it("COD=0 يبقى ظاهراً حتى ختم التسليم ثم يُغلق تشغيلياً", async () => {
    const { partyA } = await seedParties();
    const woId = await readyReception();
    await db().update(s.workOrders).set({ deposit: "10000.00" }).where(eq(s.workOrders.id, woId));
    const disp = await dispatchToDelivery({ workOrderId: woId, partyId: partyA, deliveryFee: "0" }, CASHIER);
    const before = await consignment(disp.consignmentId);
    expect(before.status).toBe("DISPATCHED");
    expect(before.settledAt).not.toBeNull();
    expect((await listMyDeliveries(3)).toDeliver.some((r) => r.id === disp.consignmentId && r.kind === "consignment")).toBe(true);

    await advanceToOutForDelivery(disp.consignmentId);
    await confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 3 });
    const after = await consignment(disp.consignmentId);
    expect(after.status).toBe("DELIVERED");
    expect(after.courierDeliveredAt).not.toBeNull();
    expect((await listMyDeliveries(3)).delivered.some((r) => r.id === disp.consignmentId && r.kind === "consignment")).toBe(true);
  });

  it("PARTIAL يبقى في حساب المندوب ويمكن ختم تسليمه بعد أول توريد", async () => {
    const { partyA } = await seedParties();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const disp = await dispatchReception(partyA);
    await advanceToOutForDelivery(disp.consignmentId);
    await confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 3 });
    await recordDeliveryRemittance(
      { branchId: 1, partyId: partyA, countedCash: "4000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "4000" }] },
      CASHIER,
    );
    const partial = await consignment(disp.consignmentId);
    expect(partial.status).toBe("PARTIAL");
    expect(partial.remittanceId).not.toBeNull();
    expect(partial.moneyStatus).toBe("PARTIAL");
    expect((await listMyDeliveries(3)).delivered.some((r) => r.id === disp.consignmentId && r.codDue === "6000.00")).toBe(true);
    expect(await partyBalance(partyA)).toBe("6000.00");
  });

  it("(ج) بعد ختم المندوب، توريد الموظّف يُسوّي الإرسالية طبيعياً (DELIVERED + PAYMENT_IN + خفض العهدة + PAID)", async () => {
    const { partyA } = await seedParties();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId: 2, branchId: 1 });
    const disp = await dispatchReception(partyA);

    const payInBefore = await entryCount("PAYMENT_IN");
    await advanceToOutForDelivery(disp.consignmentId);
    // المندوب يختم التسليم أولاً (لا أثر مالي).
    await confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 3 });
    expect(await entryCount("PAYMENT_IN")).toBe(payInBefore + 1);

    // ثم الموظّف يورّد النقد ⇒ المال يُسوَّى الآن، ومسار التوريد لم يتأثّر بالختم.
    const rem = await recordDeliveryRemittance(
      { branchId: 1, partyId: partyA, countedCash: "10000", lines: [{ consignmentId: disp.consignmentId, collectedAmount: "10000" }] },
      CASHIER,
    );
    expect(rem.status).toBe("BALANCED");
    expect(rem.collectedTotal).toBe("10000.00");

    const cn = await consignment(disp.consignmentId);
    expect(cn.status).toBe("DELIVERED"); // التسوية تنقلها الآن
    expect(cn.collectedAmount).toBe("10000.00");
    expect(cn.remittanceId).not.toBeNull();
    expect(cn.settledAt).not.toBeNull();
    expect(cn.courierDeliveredAt).not.toBeNull(); // ختم المندوب باقٍ

    expect(await partyBalance(partyA)).toBe("0.00"); // العهدة خُفِضت بالتوريد
    const inv = await invoice(disp.invoiceId);
    expect(inv.status).toBe("PAID");
    expect(inv.paidAmount).toBe("10000.00");
    expect(await entryCount("PAYMENT_IN")).toBe(payInBefore + 1); // قيد التسوية أُنشئ عند التوريد
    await reconcileClean();
  });

  it("(د) IDOR: مندوب آخر لا يختم إرسالية ليست له (FORBIDDEN) بلا تغيير", async () => {
    const { partyA } = await seedParties();
    const disp = await dispatchReception(partyA); // لجهة أ (userId 3)
    await advanceToOutForDelivery(disp.consignmentId);
    await expect(
      confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 4 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await consignment(disp.consignmentId)).courierDeliveredAt).toBeNull(); // لم يُختَم
    expect(await partyBalance(partyA)).toBe("0.00");
  });

  it("idempotent: ختمٌ مزدوج ⇒ alreadyDelivered بنفس الطابع بلا تغيير", async () => {
    const { partyA } = await seedParties();
    const disp = await dispatchReception(partyA);
    await advanceToOutForDelivery(disp.consignmentId);
    const first = await confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 3 });
    expect(first.alreadyDelivered).toBeUndefined();
    const stampAfterFirst = (await consignment(disp.consignmentId)).courierDeliveredAt;

    const second = await confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 3 });
    expect(second.alreadyDelivered).toBe(true);
    const stampAfterSecond = (await consignment(disp.consignmentId)).courierDeliveredAt;
    expect(new Date(stampAfterSecond!).getTime()).toBe(new Date(stampAfterFirst!).getTime()); // لم يتغيّر
  });

  it("حساب غير مرتبط بجهة ⇒ الختم يُرفض (FORBIDDEN)", async () => {
    const { partyA } = await seedParties();
    const disp = await dispatchReception(partyA);
    await expect(
      confirmConsignmentDelivery({ consignmentId: disp.consignmentId }, { userId: 1 }), // المدير بلا جهة
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// يعيد partyIds من بذرة beforeEach بقراءتها بالاسم/المستخدم (تفادي حالة مشتركة).
async function seedParties(): Promise<{ partyA: number; partyB: number }> {
  const d = db();
  const a = (await d.select({ id: s.deliveryParties.id }).from(s.deliveryParties).where(eq(s.deliveryParties.userId, 3)).limit(1))[0];
  const b = (await d.select({ id: s.deliveryParties.id }).from(s.deliveryParties).where(eq(s.deliveryParties.userId, 4)).limit(1))[0];
  return { partyA: Number(a.id), partyB: Number(b.id) };
}
