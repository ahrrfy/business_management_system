/**
 * ش٤ — العرابين على مسوّدات الاستقبال (orderPayments + preCollected).
 * docs/reception-cashier-system-design-2026-08-05.md §٥.٣ + §٧.٢-٧.٣ + ثوابت I2-I17.
 *
 * المُثبَت:
 *  D1 (I5+I7+I12) — عربون نقديّ ثم تثبيتٌ بالباقي ⇒ **لا إيصال ثانٍ لمال العربون**: إيصال
 *      الباقي وحده جديد، paidAmount كامل، إيصال العربون أحاديّ الهدف يُختم بالفاتورة،
 *      والدرج = العربون + الباقي والوردية **تُغلق بفارق صفر**.
 *  D2 (I6) — مسوّدة تخصيصٍ بعربون ⇒ تثبيت بلا collectNow ⇒ WO.deposit = العربون بلا إيصالٍ
 *      جديد (N=0)، والتسليم يُصدر فاتورةً بمتبقٍّ صحيح ⇒ إجمالي ما دفعه الزبون = السعر بالضبط.
 *  D3 — إلغاء أمرٍ عربونُه مقبوضٌ سلفاً ⇒ حصّة P تُردّ بإيصال OUT بطريقة قبضها + صفّ REFUND.
 *  D4 (I2) — قبضان متزامنان يتجاوزان الإجمالي ⇒ الثاني يُرفض تحت قفل الصفّ.
 *  D5 (I3 + القاعدة ٧) — بعد القبض: حذف بندٍ مرفوض، وخفض الإجمالي دون المقبوض مرفوض،
 *      وتثبيتٌ بإجماليٍّ أقل من المقبوض مرفوض.
 *  D6 (I7) — عربون بطاقة ⇒ cashBucket NULL خارج expectedCash والوردية تُغلق بالنقد وحده.
 *  D7 (I17) — الردّ بطريقة القبض حتماً وبسقف المتبقّي؛ الردّ الكامل يقفل القبض REFUNDED.
 *  D8 (V12) — نقديّ ووردية RETAIL وحدها ⇒ رفضٌ صريح؛ مديرٌ بلا وردية ⇒ رفض.
 *  D9 (I11) — عربون عميلٍ مسجَّل ⇒ reconcile drift صفر، currentBalance لم يُمسّ،
 *      وكشفه يحمل سطر إفصاح heldDepositsTotal.
 *  D10 (I14) — المسوّدة المموّلة لا تمنع إغلاق الوردية، والكنّاس لا يطويها، وZ يحمل الإفصاح.
 *  D11 — إلغاء مسوّدةٍ عليها محتجزٌ مرفوض حتى يُردّ؛ وبعد الردّ الكامل يبقى الإلغاء مديرياً.
 *  D12 (I8) — إعادة التثبيت تعيد نفس appliedPayments بلا تطبيقٍ مزدوج.
 *  R8 (مراجعة Codex على PR #988) — إلغاء فاتورةٍ مموَّلة بعربونٍ مُشظّى بين هدفين (بلا إيصالٍ
 *      مختوم) يستردّ نقدها فعلياً؛ سقف refundable في cancelSaleInTx يرى حصّة APPLICATION غير
 *      المختومة الآن (نفس استعلام returns/refundCaps.ts خطوة ②).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep exercising downstream refund/accounting rules for historical external
// receipts. Dedicated policy suites cover the production fail-closed boundary.
vi.mock("../posPaymentPolicy", () => ({ assertPosPaymentMethodEnabled: () => undefined }));
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, getShiftReport, openShift } from "../shiftService";
import { reconcileCustomerBalances } from "../reconcileService";
import { getCustomerStatement } from "../reports/arAging";
import { getAnomalyWatch } from "../reports/anomalyWatch";
import { returnSale } from "../returnService";
import { cancelSale } from "../sale/cancel";
import { deliverWorkOrder } from "../workOrder/deliver";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import {
  cancelDraft,
  collectDeposit,
  commitDraft,
  listDraftPayments,
  promoteDraft,
  refundDeposit,
  sweepExpiredDrafts,
  syncDraft,
} from "../reception";

const TABLES = [
  "workOrderEvents", "workOrderControlRequests",
  "workOrderDesignApprovals", "workOrderDesignRevisions",
  "taskEvents", "tasks", "serviceTypes", "auditLogs",
  "orderPayments", "receptionDraftLines", "receptionDrafts",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const CASHIER2 = { userId: 5, branchId: 1, role: "cashier" };

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
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "rc2", name: "موظف ثانٍ", email: "r2@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    blocksExecution: true,
    isActive: true,
  });
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

const GOODS_LINE = {
  lineKind: "GOODS" as const, variantId: 1, productUnitId: 1,
  quantity: "2", unitPrice: "1000.00", title: "دفتر (قطعة)",
};
const CUSTOM_LINE = {
  lineKind: "CUSTOM" as const, quantity: "1", unitPrice: "45000.00", title: "درع تكريم",
  printSpec: JSON.stringify({ laborCost: "0", priority: "NORMAL", hasDelivery: false }),
};

async function promoteMixed(customerId: number | null = 1) {
  return promoteDraft(
    { branchId: 1, header: customerId ? { customerId } : { contactName: "زبون عابر" }, lines: [GOODS_LINE, CUSTOM_LINE] },
    CASHIER,
  );
}

const uuid = (tag: string) => `${tag}-0000-4000-8000-000000000000`.slice(0, 36);

async function approveCurrentDesign(woId: number, tag: string) {
  const requested = await requestWorkOrderDesignApproval(
    {
      workOrderId: woId,
      requestKey: `reception-design-request-${tag}`,
      note: "اعتماد التصميم قبل التسليم",
    },
    CASHIER,
  );
  await decideWorkOrderDesignApproval(
    {
      approvalId: Number(requested.approval.id),
      decisionKey: `reception-design-decision-${tag}`,
      decision: "APPROVED",
      reason: "وافق العميل على التصميم النهائي",
      evidence: {
        type: "WHATSAPP_MESSAGE",
        reference: `wamid.reception.${tag}`,
      },
    },
    MANAGER,
  );
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("D1 — عربون نقدي ثم تثبيت: لا إيصال ثانٍ والوردية تُغلق بفارق صفر", () => {
  it("I5+I7+I12: إيصال العربون يبقى بمبلغه، الجديد للباقي وحده، وexpectedCash يطابق العدّ", async () => {
    const shift = await openReception();
    const p = await promoteMixed();
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("d1c00001") },
      CASHIER,
    );
    expect(dep.collectedTotal).toBe("10000.00");

    // moneyLocked رُفع وقيد PAYMENT_IN كُتب بلا invoiceId وبوسم الاحتجاز.
    const draft = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, p.draftId)))[0];
    expect(draft.moneyLocked).toBe(true);
    const depEntry = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.receiptId, dep.receiptId)))[0];
    expect(depEntry.entryType).toBe("PAYMENT_IN");
    expect(depEntry.invoiceId).toBeNull();
    expect(String(depEntry.notes)).toContain("DRAFT_DEPOSIT");

    // التثبيت: الباقي 37,000 نقداً (الإجمالي 47,000 − عربون 10,000).
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId,
      collectNow: { amount: "37000.00", method: "CASH" },
    }, CASHIER);
    expect(r.heldApplied).toBe("10000.00");
    expect(r.appliedPayments.length).toBeGreaterThan(0);

    // الفاتورة (بيع مباشر 2000) مدفوعة كاملاً، والأمر عربونه 45,000 (P+N).
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.regularSale!.invoiceId)))[0];
    expect(inv.total).toBe("2000.00");
    expect(inv.paidAmount).toBe("2000.00");
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrders[0].workOrderId)))[0];
    expect(wo.deposit).toBe("45000.00");
    expect(r.workOrders[0].deposit).toBe("45000.00");

    // I5: إيصالات IN على الوردية = إيصال العربون (10,000) + إيصالا التثبيت للجزء الجديد فقط —
    // Σ الإيصالات = النقد الحقيقي المستلم 47,000 (لا 57,000 المزدوجة).
    const ins = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.shiftId, shift.shiftId), eq(s.receipts.direction, "IN")));
    const totalIn = ins.reduce((a, x) => a + Number(x.amount), 0);
    expect(totalIn).toBe(47000);
    // إيصال العربون لم يُضاعَف ولم يتغيّر مبلغه.
    const depReceipt = ins.find((x) => Number(x.id) === dep.receiptId)!;
    expect(depReceipt.amount).toBe("10000.00");

    // القبض صار APPLIED وتطبيقاته تُغطّي 10,000 (I4).
    const apps = await db().select().from(s.orderPayments)
      .where(and(eq(s.orderPayments.draftId, p.draftId), eq(s.orderPayments.kind, "APPLICATION")));
    expect(apps.reduce((a, x) => a + Number(x.amount), 0)).toBe(10000);
    const coll = (await db().select().from(s.orderPayments).where(eq(s.orderPayments.id, dep.paymentId)))[0];
    expect(coll.status).toBe("APPLIED");

    // I7: الوردية تُغلق بفارق صفر على 47,000.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "47000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("D2 — I6: عربونٌ يصل أمر الشغل فعلاً والتسليم بمتبقٍّ صحيح", () => {
  it("تخصيصٌ خالص بعربون 20,000 ⇒ تثبيت بلا collectNow ⇒ N=0 ⇒ تسليم بالباقي = السعر بالضبط", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE] }, CASHIER);
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "20000.00", method: "CASH", clientRequestId: uuid("d2c00001") },
      CASHIER,
    );
    const receiptsBefore = (await db().select().from(s.receipts)).length;

    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "45000.00", shiftId: shift.shiftId,
      collectNow: null,
    }, CASHIER);
    const woId = r.workOrders[0].workOrderId;
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.deposit).toBe("20000.00");
    // N=0 ⇒ لا إيصال جديد عند الإنشاء (I5) وdepositReceiptId فارغ (لا إيصال أنشأه هو).
    expect((await db().select().from(s.receipts)).length).toBe(receiptsBefore);
    expect(wo.depositReceiptId).toBeNull();

    // التسليم بالباقي 25,000 ⇒ الفاتورة مدفوعة كاملاً وإجمالي المدفوع = السعر بالضبط.
    await approveCurrentDesign(woId, "d2");
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
    const delivered = await deliverWorkOrder(
      { workOrderId: woId, payment: { amount: "25000.00", method: "CASH" } }, CASHIER,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, delivered.invoiceId)))[0];
    expect(inv.total).toBe("45000.00");
    expect(inv.paidAmount).toBe("45000.00");
    expect(inv.status).toBe("PAID");
    // إيصال العربون أحاديّ الهدف ⇒ خُتم بفاتورة التسليم (deposits.linkSoleTargetCollections).
    const depReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, dep.receiptId)))[0];
    expect(Number(depReceipt.invoiceId)).toBe(delivered.invoiceId);
    // الدرج = 20,000 عربون + 25,000 تسليم.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "45000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("D3 — إلغاء أمرٍ عربونُه مقبوض سلفاً يردّ حصّة P بطريقتها", () => {
  it("cancelWorkOrder يكتب OUT نقدياً بمبلغ الحصّة + صفّ REFUND مربوطاً بالقبض الأم", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [CUSTOM_LINE] }, CASHIER);
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "15000.00", method: "CASH", clientRequestId: uuid("d3c00001") },
      CASHIER,
    );
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "45000.00", shiftId: shift.shiftId, collectNow: null,
    }, CASHIER);
    const woId = r.workOrders[0].workOrderId;

    const [current] = await db()
      .select({ version: s.workOrders.version })
      .from(s.workOrders)
      .where(eq(s.workOrders.id, woId));
    const request = await requestWorkOrderControl(
      {
        requestKey: `reception-cancel-${woId}`,
        workOrderId: woId,
        requestType: "CANCEL",
        baseVersion: Number(current.version),
        reason: "إلغاء بطلب العميل ورد العربون",
        payload: { refundShiftId: shift.shiftId },
      },
      CASHIER,
    );
    await approveWorkOrderControlRequest(
      Number(request.id),
      MANAGER,
      "تم التحقق من طلب العميل ومبلغ الرد",
    );

    const outs = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.workOrderId, woId), eq(s.receipts.direction, "OUT")));
    expect(outs.length).toBe(1);
    expect(outs[0].amount).toBe("15000.00");
    expect(outs[0].paymentMethod).toBe("CASH");
    expect(outs[0].cashBucket).toBe("DRAWER");
    const refunds = await db().select().from(s.orderPayments)
      .where(and(eq(s.orderPayments.parentPaymentId, dep.paymentId), eq(s.orderPayments.kind, "REFUND")));
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe("15000.00");
    // الدرج: +15,000 قبض −15,000 ردّ = 0 ⇒ الإغلاق بفارغ الدرج.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "0.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("D4 — I2: قبضان متزامنان لا يتجاوزان الإجمالي معاً", () => {
  it("سباق حقيقي: 30,000 + 25,000 على طلبٍ إجماليه 47,000 ⇒ واحدٌ يمرّ والثاني يُرفض", async () => {
    await openReception();
    const p = await promoteMixed();
    const results = await Promise.allSettled([
      collectDeposit({ draftId: p.draftId, amount: "30000.00", method: "CASH", clientRequestId: uuid("d4c00001") }, CASHIER),
      collectDeposit({ draftId: p.draftId, amount: "25000.00", method: "CASH", clientRequestId: uuid("d4c00002") }, CASHIER),
    ]);
    const ok = results.filter((x) => x.status === "fulfilled");
    const failed = results.filter((x) => x.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    const colls = await db().select().from(s.orderPayments)
      .where(and(eq(s.orderPayments.draftId, p.draftId), eq(s.orderPayments.kind, "COLLECTION")));
    expect(colls.length).toBe(1);
  });
});

describe("D5 — I3 + القاعدة ٧: المموّلة محروسة تحريراً وتثبيتاً", () => {
  it("حذف بند ⇒ مرفوض؛ خفض دون المقبوض ⇒ مرفوض؛ تثبيت بإجمالي أقل من المقبوض ⇒ مرفوض قبل أي كتابة", async () => {
    const shift = await openReception();
    const p = await promoteMixed();
    await collectDeposit(
      { draftId: p.draftId, amount: "40000.00", method: "CASH", clientRequestId: uuid("d5c00001") },
      CASHIER,
    );

    // حذف بند (سطران ⇒ سطر واحد).
    await expect(syncDraft({
      draftId: p.draftId, version: 0, header: { customerId: 1 }, lines: [CUSTOM_LINE],
    }, CASHIER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // خفض السعر دون المقبوض (سطران يبقيان لكن الإجمالي 32,000 < 40,000).
    await expect(syncDraft({
      draftId: p.draftId, version: 0, header: { customerId: 1 },
      lines: [GOODS_LINE, { ...CUSTOM_LINE, unitPrice: "30000.00" }],
    }, CASHIER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // القاعدة ٧ عند التثبيت: نخفض تحت المقبوض مباشرة في القاعدة (تجاوز الحارس) ثم نثبّت.
    await db().update(s.receptionDraftLines)
      .set({ unitPrice: "10000.00", lineTotal: "10000.00" })
      .where(and(eq(s.receptionDraftLines.draftId, p.draftId), eq(s.receptionDraftLines.lineKind, "CUSTOM")));
    await expect(commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "12000.00", shiftId: shift.shiftId,
      collectNow: null,
    }, CASHIER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.invoices)).length).toBe(0);
    expect((await db().select().from(s.workOrders)).length).toBe(0);
  });
});

describe("D6 — عربون بطاقة خارج الدرج", () => {
  it("cashBucket NULL ⇒ لا يدخل expectedCash والوردية تُغلق على النقد وحده", async () => {
    const shift = await openReception();
    const p = await promoteMixed();
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "20000.00", method: "CARD", reference: "CARD-778", clientRequestId: uuid("d6c00001") },
      CASHIER,
    );
    const depReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, dep.receiptId)))[0];
    expect(depReceipt.cashBucket).toBeNull();
    expect(depReceipt.paymentMethod).toBe("CARD");
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "0.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("D7 — I17: الردّ بطريقة القبض حصراً وبسقف المتبقّي", () => {
  it("قبض بطاقة ⇒ الردّ بطاقةً (لا نقداً) + سقف المتبقّي + الردّ الكامل يقفل REFUNDED", async () => {
    await openReception();
    const p = await promoteMixed();
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "20000.00", method: "CARD", reference: "CARD-9", clientRequestId: uuid("d7c00001") },
      CASHIER,
    );
    // تجاوز السقف مرفوض.
    await expect(refundDeposit(
      { paymentId: dep.paymentId, amount: "25000.00", reason: "طلب الزبون استرداداً", clientRequestId: uuid("d7r00001") },
      CASHIER,
    )).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const r1 = await refundDeposit(
      { paymentId: dep.paymentId, amount: "5000.00", reason: "استرداد جزئي بطلب الزبون", clientRequestId: uuid("d7r00002") },
      CASHIER,
    );
    const refundReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, r1.refundReceiptId!)))[0];
    // بطريقة القبض حتماً: بطاقة، خارج الدرج — «ردّ غير النقدي نقداً» مستحيلٌ بنيوياً.
    expect(refundReceipt.paymentMethod).toBe("CARD");
    expect(refundReceipt.cashBucket).toBeNull();
    expect(refundReceipt.direction).toBe("OUT");

    await refundDeposit(
      { paymentId: dep.paymentId, amount: "15000.00", reason: "استرداد الباقي كاملاً", clientRequestId: uuid("d7r00003") },
      CASHIER,
    );
    const coll = (await db().select().from(s.orderPayments).where(eq(s.orderPayments.id, dep.paymentId)))[0];
    expect(coll.status).toBe("REFUNDED");
    // بعد الاستنزاف الكامل: أيّ ردٍّ إضافيّ مرفوض.
    await expect(refundDeposit(
      { paymentId: dep.paymentId, amount: "1000.00", reason: "محاولة بعد الإقفال", clientRequestId: uuid("d7r00004") },
      CASHIER,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("D8 — V12: وردية استقبالٍ مُلزَمة بنوعها", () => {
  it("نقديّ ووردية RETAIL وحدها مفتوحة ⇒ رفضٌ يسمّي النوع؛ ومدير بلا وردية ⇒ رفض", async () => {
    const p = await promoteMixed();
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 2, branchId: 1 });
    await expect(collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "CASH", clientRequestId: uuid("d8c00001") },
      CASHIER,
    )).rejects.toThrowError(/ليست وردية استقبال/);

    await expect(collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "CASH", clientRequestId: uuid("d8c00002") },
      MANAGER,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("D9 — I11: عربون عميلٍ مسجَّل لا يكذب على الذمم", () => {
  it("reconcile drift = 0، currentBalance لم يُمسّ، والكشف يحمل heldDepositsTotal", async () => {
    await openReception();
    const p = await promoteMixed(1);
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("d9c00001") },
      CASHIER,
    );
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00");
    const issues = await reconcileCustomerBalances();
    expect(issues.filter((i) => i.entity === "customer")).toEqual([]);
    const stmt = await getCustomerStatement(1);
    expect(stmt!.summary.heldDepositsTotal).toBe("10000.00");
    // العربون ليس «سنداً مستقلاً» في حركات الكشف (لا partyType عليه).
    expect(stmt!.payments.filter((x) => x.isStandalone)).toEqual([]);
  });
});

describe("D10 — I14: المموّلة لا تمنع الإغلاق ولا يطويها الكنّاس", () => {
  it("إغلاقٌ ناجح + سطر إفصاح Z + الكنّاس يتجاوزها بعد انقضاء أجلها", async () => {
    const shift = await openReception();
    const p = await promoteMixed();
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("dAc00001") },
      CASHIER,
    );
    const rep = await getShiftReport(shift.shiftId);
    expect(rep!.heldDepositsCount).toBe(1);
    expect(rep!.heldDepositsTotal).toBe("10000.00");
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "10000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");

    // الكنّاس: نُقادِم expiresAt ثم نكنس — المموّلة تبقى OPEN.
    await db().update(s.receptionDrafts)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(s.receptionDrafts.id, p.draftId));
    await sweepExpiredDrafts();
    const draft = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, p.draftId)))[0];
    expect(draft.status).toBe("OPEN");
  });
});

describe("D11 — لا إلغاء وطلبٌ عليه محتجز؛ وبعد الردّ يبقى مديرياً", () => {
  it("cancelDraft يُرفض بالمحتجز، وبعد ردّه الكامل: الكاشير FORBIDDEN والمدير يمرّ", async () => {
    await openReception();
    const p = await promoteMixed();
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "8000.00", method: "CASH", clientRequestId: uuid("dBc00001") },
      CASHIER,
    );
    await expect(cancelDraft(
      { draftId: p.draftId, version: 0, reason: "الزبون عدل عن الطلب كاملاً" }, MANAGER,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await refundDeposit(
      { paymentId: dep.paymentId, amount: "8000.00", reason: "الزبون عدل عن الطلب", clientRequestId: uuid("dBr00001") },
      CASHIER,
    );
    // moneyLocked لا يهبط ⇒ الإلغاء يبقى مديرياً حتى بعد الردّ الكامل.
    await expect(cancelDraft(
      { draftId: p.draftId, version: 0, reason: "محاولة كاشير" }, CASHIER,
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    const done = await cancelDraft(
      { draftId: p.draftId, version: 0, reason: "الزبون عدل عن الطلب — دُوّنت بنوده" }, MANAGER,
    );
    expect(done.status).toBe("CANCELLED");
  });
});

describe("R1 — مراجعة: القبض المردود جزئياً لا يُختم إيصالُه (سقف المرتجع يصدق)", () => {
  it("قبض 20,000 ← ردّ 5,000 ← تثبيت تخصيصٍ خالص ← تسليم آجل ⇒ الإيصال بلا ختمٍ وسقف الاسترداد = الصافي", async () => {
    const shift = await openReception();
    // بندٌ مخصّص بمنتجٍ أساس — فاتورة تسليمه تحمل بنداً قابلاً للإرجاع (خدمة بلا منتجٍ لا بنود لها).
    const p = await promoteDraft({
      branchId: 1,
      header: { customerId: 1 },
      lines: [{ ...CUSTOM_LINE, variantId: 1, productUnitId: 1 }],
    }, CASHIER);
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "20000.00", method: "CASH", clientRequestId: uuid("r1c00001") },
      CASHIER,
    );
    await refundDeposit(
      { paymentId: dep.paymentId, amount: "5000.00", reason: "ردٌّ جزئيّ بطلب الزبون", clientRequestId: uuid("r1r00001") },
      CASHIER,
    );
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "45000.00", shiftId: shift.shiftId, collectNow: null,
    }, CASHIER);
    const woId = r.workOrders[0].workOrderId;
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, woId)))[0];
    expect(wo.deposit).toBe("15000.00"); // الصافي بعد الردّ

    await approveCurrentDesign(woId, "r1");
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
    const delivered = await deliverWorkOrder({ workOrderId: woId, payment: null }, CASHIER);
    // الإيصال المشوب بردٍّ جزئيّ (20,000 قُبضت، 15,000 صافياً) لا يُختم — مبلغه الكامل يكذب
    // على سقف استرداد المرتجع (كان يسمح بصرف 20,000 لفاتورةٍ دفعت 15,000).
    const depReceipt = (await db().select().from(s.receipts).where(eq(s.receipts.id, dep.receiptId)))[0];
    expect(depReceipt.invoiceId).toBeNull();

    // سقف الاسترداد من حصص orderPayments: مرتجعٌ كامل باسترداد 15,000 نقداً يمرّ، و16,000 يُرفض.
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, delivered.invoiceId)))[0];
    await expect(returnSale(
      {
        invoiceId: delivered.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: Number(item.baseQuantity) }],
        refund: { amount: "16000.00", method: "CASH", shiftId: shift.shiftId },
      },
      MANAGER,
    )).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await returnSale(
      {
        invoiceId: delivered.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: Number(item.baseQuantity) }],
        refund: { amount: "15000.00", method: "CASH", shiftId: shift.shiftId },
      },
      MANAGER,
    );
    // الدرج: +20,000 −5,000 −15,000 = 0.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "0.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("R2 — مراجعة: العربون المُشظّى بين هدفين قابلٌ للاسترداد عبر حصص التخصيص", () => {
  it("بضاعة 2,000 + تخصيص، عربونٌ واحد يغطّيهما ⇒ مرتجع البضاعة يستردّ نقدها رغم غياب إيصالٍ مختوم", async () => {
    const shift = await openReception();
    const p = await promoteMixed(1);
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("r2c00001") },
      CASHIER,
    );
    // heldNet (10,000) يغطّي البيع المباشر (2,000) ⇒ التثبيت بلا collectNow جائز — القبض يتشظّى
    // (2,000 للفاتورة + 8,000 للأمر) فلا يُختم إيصاله بأيّ فاتورة.
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId, collectNow: null,
    }, CASHIER);
    const invId = r.regularSale!.invoiceId;
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invId)))[0];
    expect(inv.paidAmount).toBe("2000.00");
    const linked = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, invId));
    expect(linked.length).toBe(0); // لا إيصال مربوط — الحقيقة في orderPayments

    // قبل الإصلاح: refundCap = 0 ⇒ رفضٌ بنيويّ لاسترداد فاتورةٍ PAID. الآن حصّة APPLICATION تدخله.
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invId)))[0];
    await returnSale(
      {
        invoiceId: invId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: Number(item.baseQuantity) }],
        refund: { amount: "2000.00", method: "CASH", shiftId: shift.shiftId },
      },
      MANAGER,
    );
    const outs = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, invId), eq(s.receipts.direction, "OUT")));
    expect(outs.length).toBe(1);
    expect(outs[0].amount).toBe("2000.00");
  });
});

describe("R3 — مراجعة: لا تغيير عميلٍ لطلبٍ عليه محتجز", () => {
  it("syncDraft بتغيير العميل يُرفض؛ وبعد الردّ الكامل يمرّ", async () => {
    await openReception();
    const p = await promoteMixed(1);
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "CASH", clientRequestId: uuid("r3c00001") },
      CASHIER,
    );
    await expect(syncDraft({
      draftId: p.draftId, version: 0, header: { customerId: null, contactName: "عابر" }, lines: [GOODS_LINE, CUSTOM_LINE],
    }, CASHIER)).rejects.toThrowError(/باسم طرفه الحاليّ/);

    await refundDeposit(
      { paymentId: dep.paymentId, amount: "5000.00", reason: "الزبون بدّل الطرف الدافع", clientRequestId: uuid("r3r00001") },
      CASHIER,
    );
    const synced = await syncDraft({
      draftId: p.draftId, version: 0, header: { customerId: null, contactName: "عابر" }, lines: [GOODS_LINE, CUSTOM_LINE],
    }, CASHIER);
    expect(synced.version).toBe(1);
  });
});

describe("R4 — مراجعة: تقريب IQD لا يسدّ الطريق النقديّ حين يساوي المحتجزُ المقرَّبَ", () => {
  it("بضاعة خام 5,100 وعربون 5,000 (= المقرَّب) ⇒ التثبيت النقديّ بالباقي الخام 100 يمرّ بلا ADJUST", async () => {
    const shift = await openReception();
    // سطر بضاعة بسعر 5,100 (خام غير مضاعفٍ لـ250، تقريبه 5,000 = العربون بالضبط).
    const p = await promoteDraft({
      branchId: 1,
      header: { customerId: 1 },
      lines: [{ lineKind: "GOODS" as const, variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "5100.00", title: "دفتر (قطعة)" }],
    }, CASHIER);
    await collectDeposit(
      { draftId: p.draftId, amount: "5000.00", method: "CASH", clientRequestId: uuid("r4c00001") },
      CASHIER,
    );
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "5100.00", shiftId: shift.shiftId,
      collectNow: { amount: "100.00", method: "CASH" },
      cashRoundIQD: true, // العميل القديم قد يرسله — الخادم يسقطه لحماية الفارغ من الوعاء
    }, CASHIER);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.regularSale!.invoiceId)))[0];
    expect(inv.total).toBe("5100.00");
    expect(inv.paidAmount).toBe("5100.00");
    expect(inv.cashRoundingAdjustment).toBe("0.00");
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "5100.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("R5 — مراجعة: الردّ النقديّ بتعدّد الدرج يتطلّب refundShiftId ويُنسَب للدرج المحدَّد", () => {
  it("ورديتان مفتوحتان ⇒ بلا تحديدٍ يُرفض؛ وبالتحديد يخرج من الدرج المختار", async () => {
    const rec = await openReception(2);
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RETAIL" }, { userId: 5, branchId: 1 });
    const p = await promoteMixed(1);
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "6000.00", method: "CASH", clientRequestId: uuid("r5c00001") },
      CASHIER,
    );
    await expect(refundDeposit(
      { paymentId: dep.paymentId, amount: "6000.00", reason: "الزبون عدل عن الطلب", clientRequestId: uuid("r5r00001") },
      CASHIER,
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const done = await refundDeposit(
      { paymentId: dep.paymentId, amount: "6000.00", reason: "الزبون عدل عن الطلب", clientRequestId: uuid("r5r00002") },
      CASHIER,
      { refundShiftId: rec.shiftId },
    );
    expect(done.idempotentReplay).toBe(false);
    const out = (await db().select().from(s.receipts).where(eq(s.receipts.id, done.refundReceiptId!)))[0];
    expect(Number(out.shiftId)).toBe(rec.shiftId);
  });
});

describe("R6 — مراجعة: عزل الفرع في سجلّ العرابين (IDOR)", () => {
  it("كاشير فرعٍ آخر يُرفض FORBIDDEN والمدير يمرّ", async () => {
    await db().insert(s.branches).values([{ id: 2, name: "المبيعات", code: "SALES", type: "SALES" }]);
    await openReception();
    const p = await promoteMixed(1);
    await collectDeposit(
      { draftId: p.draftId, amount: "3000.00", method: "CASH", clientRequestId: uuid("r6c00001") },
      CASHIER,
    );
    await expect(
      listDraftPayments(p.draftId, { userId: 9, branchId: 2, role: "cashier" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await listDraftPayments(p.draftId, { userId: 1, branchId: 1, role: "manager" });
    expect(ok.heldNet).toBe("3000.00");
  });
});

describe("R7 — مراجعة: كاشف D8 يمسك «اقبض ثم رُدّ» والمسوّدة باقية OPEN", () => {
  it("قبضان مردودان كاملاً على مسوّدتين OPEN لنفس الفاعل ⇒ العلم مرفوع", async () => {
    await openReception();
    for (const tag of ["r7a00001", "r7b00001"] as const) {
      const p = await promoteMixed(1);
      const dep = await collectDeposit(
        { draftId: p.draftId, amount: "4000.00", method: "CASH", clientRequestId: uuid(tag) },
        CASHIER,
      );
      await refundDeposit(
        { paymentId: dep.paymentId, amount: "4000.00", reason: "الزبون عدل عن الطلب", clientRequestId: uuid(tag.replace("c", "r") + "x") },
        CASHIER,
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    const aw = await getAnomalyWatch({ from: today, to: today, branchId: 1 });
    const row = aw.cancelledFundedDrafts.rows.find((x) => x.userId === 2);
    expect(row).toBeTruthy();
    expect(row!.draftCount).toBe(2);
    expect(row!.flagged).toBe(true);
  });
});

describe("D12 — I8: إعادة التثبيت تعيد نفس التخصيصات بلا ازدواج", () => {
  it("تثبيتان متتاليان ⇒ نفس appliedPayments وعدد صفوف APPLICATION ثابت", async () => {
    const shift = await openReception();
    const p = await promoteMixed();
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("dCc00001") },
      CASHIER,
    );
    const r1 = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId,
      collectNow: { amount: "37000.00", method: "CASH" },
    }, CASHIER);
    const r2 = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId,
      collectNow: { amount: "37000.00", method: "CASH" },
    }, CASHIER);
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.appliedPayments).toEqual(r1.appliedPayments);
    expect(r2.heldApplied).toBe("10000.00");
    expect(r2.workOrders).toEqual(r1.workOrders);
    const apps = await db().select().from(s.orderPayments)
      .where(and(eq(s.orderPayments.draftId, p.draftId), eq(s.orderPayments.kind, "APPLICATION")));
    expect(apps.reduce((a, x) => a + Number(x.amount), 0)).toBe(10000);
  });
});

describe("DB — قرار المالك (ب): سلطة ردّ العربون النقديّ (اعتماد المدير)", () => {
  it("(أ) نقديّ في وردية القبض نفسها وهي مفتوحة بيد قابضه ⇒ مسموح ذاتياً", async () => {
    const shift = await openReception();
    const p = await promoteMixed();
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("dbaa0001") },
      CASHIER,
    );
    const done = await refundDeposit(
      { paymentId: dep.paymentId, amount: "10000.00", reason: "الزبون عدل عن الطلب فوراً", clientRequestId: uuid("dbaa0002") },
      CASHIER,
    );
    expect(done.idempotentReplay).toBe(false);
    const out = (await db().select().from(s.receipts).where(eq(s.receipts.id, done.refundReceiptId!)))[0];
    expect(out.direction).toBe("OUT");
    expect(out.paymentMethod).toBe("CASH");
    expect(out.cashBucket).toBe("DRAWER");
    expect(Number(out.shiftId)).toBe(shift.shiftId);
    const coll = (await db().select().from(s.orderPayments).where(eq(s.orderPayments.id, dep.paymentId)))[0];
    expect(coll.status).toBe("REFUNDED");
  });

  it("(ب+ج) نقديّ بكاشير آخر ووردية القبض ليست ورديته ⇒ FORBIDDEN بلا اعتماد؛ ويمرّ بنفسه مع authorizedByManager", async () => {
    // وردية القابض (cashier #2) تبقى مفتوحة وفيها النقد؛ الطالب كاشير آخر (userId=5).
    const shift = await openReception();
    const p = await promoteMixed();
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("dbbc0001") },
      CASHIER,
    );
    // (ب) sameOpenShift=false (فاعلٌ مختلفٌ عن قابض النقد) ⇒ FORBIDDEN بلا اعتماد مدير.
    const rid = uuid("dbbc0002");
    await expect(refundDeposit(
      { paymentId: dep.paymentId, amount: "10000.00", reason: "الزبون طلب الاسترداد لاحقاً", clientRequestId: rid },
      CASHIER2,
    )).rejects.toMatchObject({ code: "FORBIDDEN" });
    // الرفض تراجع كاملاً: القبض ما زال HELD ولا صفّ REFUND (ولا مفتاح idempotency).
    const stillHeld = (await db().select().from(s.orderPayments).where(eq(s.orderPayments.id, dep.paymentId)))[0];
    expect(stillHeld.status).toBe("HELD");
    const refundsBefore = await db().select().from(s.orderPayments)
      .where(and(eq(s.orderPayments.parentPaymentId, dep.paymentId), eq(s.orderPayments.kind, "REFUND")));
    expect(refundsBefore.length).toBe(0);

    // (ج) نفس الردّ (نفس clientRequestId — مرآة إعادة محاولة الواجهة) باعتماد مدير ⇒ يمرّ؛
    //     النقد يخرج من درج القبض المفتوح (shift #2).
    const done = await refundDeposit(
      { paymentId: dep.paymentId, amount: "10000.00", reason: "الزبون طلب الاسترداد لاحقاً", clientRequestId: rid },
      CASHIER2,
      { authorizedByManager: true },
    );
    expect(done.idempotentReplay).toBe(false);
    const out = (await db().select().from(s.receipts).where(eq(s.receipts.id, done.refundReceiptId!)))[0];
    expect(out.direction).toBe("OUT");
    expect(out.paymentMethod).toBe("CASH");
    expect(out.cashBucket).toBe("DRAWER");
    expect(Number(out.shiftId)).toBe(shift.shiftId);
    const coll = (await db().select().from(s.orderPayments).where(eq(s.orderPayments.id, dep.paymentId)))[0];
    expect(coll.status).toBe("REFUNDED");
  });

  it("(د) عربون بطاقة يُردّ بأيّ كاشير في أيّ وقت بلا اعتماد مدير (الحارس على النقد وحده)", async () => {
    await openReception(); // قابض البطاقة (cashier #2) — وردية القبض
    const p = await promoteMixed();
    const dep = await collectDeposit(
      { draftId: p.draftId, amount: "20000.00", method: "CARD", reference: "CARD-42", clientRequestId: uuid("dbdd0001") },
      CASHIER,
    );
    // كاشير آخر (userId=5) بلا وردية ولا اعتماد مدير ⇒ الردّ بطاقةً ذاتيٌّ (غير النقد لا يمرّ بالحارس).
    const done = await refundDeposit(
      { paymentId: dep.paymentId, amount: "20000.00", reason: "الزبون ألغى — استرداد على البطاقة", clientRequestId: uuid("dbdd0002") },
      CASHIER2,
    );
    expect(done.idempotentReplay).toBe(false);
    const out = (await db().select().from(s.receipts).where(eq(s.receipts.id, done.refundReceiptId!)))[0];
    expect(out.direction).toBe("OUT");
    expect(out.paymentMethod).toBe("CARD");
    expect(out.cashBucket).toBeNull();
    const coll = (await db().select().from(s.orderPayments).where(eq(s.orderPayments.id, dep.paymentId)))[0];
    expect(coll.status).toBe("REFUNDED");
  });
});

describe("R8 — مراجعة (Codex على PR #988): إلغاء فاتورةٍ مموَّلة من عربونٍ مُشظّى بين هدفين", () => {
  it("بضاعة 2,000 + تخصيص، عربونٌ واحد يغطّيهما ⇒ cancelSale يستردّ 2,000 رغم غياب إيصالٍ مختوم", async () => {
    const shift = await openReception();
    const p = await promoteMixed(1);
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("r8c00001") },
      CASHIER,
    );
    // heldNet (10,000) يغطّي البيع المباشر (2,000) ⇒ التثبيت بلا collectNow جائز — القبض يتشظّى
    // (2,000 للفاتورة + 8,000 للأمر) فلا يُختم إيصاله بأيّ فاتورة (نفس تمهيد R2).
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId, collectNow: null,
    }, CASHIER);
    const invId = r.regularSale!.invoiceId;
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invId)))[0];
    expect(inv.paidAmount).toBe("2000.00");
    const linked = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, invId));
    expect(linked.length).toBe(0); // لا إيصال مربوط — الحقيقة في orderPayments

    // قبل الإصلاح: refundable = 0 (materialReceipts لا يرى حصّة APPLICATION غير المختومة)
    // ⇒ لا استرداد لفاتورةٍ PAID بالكامل، والفاتورة تُلغى بلا ردّ مالٍ للعميل رغم دفعه فعلاً.
    // المُلغي MANAGER لا CASHIER: cancelSaleInTx يرفض إلغاء منشئ الفاتورة نفسه (فصل مهام) —
    // CASHIER هو من ثبّت المسوّدة. MANAGER بلا وردية ⇒ TREASURY؛ نموّلها هنا (نظير saleCancel
    // .test.ts) كي لا يعتمد الاختبار على وردية درجٍ لا صلة لها بموضوع الإصلاح.
    await db().insert(s.receipts).values({
      branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "10000.00",
      paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-FUND-R8", createdBy: 1,
    });
    const cancelled = await cancelSale({ invoiceId: invId, refundPaymentMethod: "CASH" }, MANAGER);
    expect(cancelled.refundAmount).toBe("2000.00");
    const invAfter = (await db().select().from(s.invoices).where(eq(s.invoices.id, invId)))[0];
    expect(invAfter.status).toBe("CANCELLED");
    const outs = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, invId), eq(s.receipts.direction, "OUT")));
    expect(outs.length).toBe(1);
    expect(outs[0].amount).toBe("2000.00");
    expect(outs[0].status).toBe("COMPLETED");
    expect(outs[0].approvalStatus).toBe("APPROVED");

    // orderPayments غير مُلزَمٍ بالتزامن هنا (نظير returnService — الحقيقة الحاكمة بعد التطبيق
    // في receipts/accountingEntries؛ العربون الأصل يبقى تاريخاً APPLIED لا يُعاد فتحه).
    const collectionRow = (
      await db().select().from(s.orderPayments)
        .where(and(eq(s.orderPayments.draftId, p.draftId), eq(s.orderPayments.kind, "COLLECTION")))
    )[0];
    expect(collectionRow.status).toBe("APPLIED");
  });

  it("idempotency: نفس clientRequestId يُعيد نفس refundAmount بلا استرداد ثانٍ (لا يخطف إيصال الحصّة السابقة)", async () => {
    const shift = await openReception();
    const p = await promoteMixed(1);
    await collectDeposit(
      { draftId: p.draftId, amount: "10000.00", method: "CASH", clientRequestId: uuid("r8c00002") },
      CASHIER,
    );
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId, collectNow: null,
    }, CASHIER);
    const invId = r.regularSale!.invoiceId;
    await db().insert(s.receipts).values({
      branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "10000.00",
      paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-TREASURY-FUND-R8B", createdBy: 1,
    });

    const first = await cancelSale(
      { invoiceId: invId, refundPaymentMethod: "CASH", clientRequestId: uuid("r8x00001") },
      MANAGER,
    );
    expect(first.idempotentReplay).toBeUndefined();
    expect(first.refundAmount).toBe("2000.00");

    const replay = await cancelSale(
      { invoiceId: invId, refundPaymentMethod: "CASH", clientRequestId: uuid("r8x00001") },
      MANAGER,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.refundAmount).toBe("2000.00");
    const outs = await db().select().from(s.receipts)
      .where(and(eq(s.receipts.invoiceId, invId), eq(s.receipts.direction, "OUT")));
    expect(outs.length).toBe(1); // لا استرداد ثانٍ
  });
});
