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
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, getShiftReport, openShift } from "../shiftService";
import { reconcileCustomerBalances } from "../reconcileService";
import { getCustomerStatement } from "../reports/arAging";
import { deliverWorkOrder } from "../workOrder/deliver";
import { cancelWorkOrder } from "../workOrder/cancel";
import {
  cancelDraft,
  collectDeposit,
  commitDraft,
  promoteDraft,
  refundDeposit,
  sweepExpiredDrafts,
  syncDraft,
} from "../reception";

const TABLES = [
  "orderPayments", "receptionDraftLines", "receptionDrafts",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const MANAGER = { userId: 1, branchId: 1, role: "manager" };
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
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
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

    await cancelWorkOrder(woId, MANAGER);

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
