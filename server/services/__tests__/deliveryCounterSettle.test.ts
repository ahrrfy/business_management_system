/**
 * السداد الكاونتري بعد ثبوت التسليم (٢٢/٨) — فكّ فخّ «متبقٍّ بلا مدخل نقدي»:
 *
 *  C1 — كشف شركة جزئي (12k من 20k) ثم قبض كاونتري 8k: يمرّ، الفاتورة PAID، التعرّض
 *       يُغلق (codOutstanding=0)، counterSettledAmount=8000 يخفض سقف التوريد إلى ما
 *       بيد الشركة فعلاً (12k)، والعهدة لا تُمسّ. وإعادة نفس مفتاح الدفعة لا تُضاعف شيئاً.
 *  C2 — قبض كاونتري جزئي (3k من متبقّي 8k): يتراكم على counterSettledAmount ويُبقي
 *       الفاتورة PARTIAL حتى يكتمل.
 *  C3 — إرسالية ما زالت بالطريق (parcelStatus غير نهائية): الحارس يرفض كما كان — الواقع
 *       الفيزيائيّ هو المقياس لا حالة الدفتر.
 *  C4 — فاتورة بلا إرسالية: القبض يمرّ بلا أيّ أثر توصيليّ (لا قيد ولا حدث).
 *  C5 — idempotency على refKey: نفس المفتاح مرّتين = تدوينة واحدة (الثانية no-op).
 *  C6 — قناة الإثبات المستندي (طرد سُلّم بلا أيّ تحصيل): سداد كاونتري كامل يغلق الإرسالية
 *       نهائياً (SETTLED، لا شيء يُورَّد) — سيناريو الطرود الجامدة الإنتاجيّ.
 */
import { eq, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { confirmConsignmentDelivery, transitionConsignmentParcel } from "../delivery/courier";
import { assertNoInTransitConsignment } from "../delivery/guards";
import { registerCounterCollectionTx } from "../delivery/counterCollection";
import { getDeliveryFinancialSummary } from "../delivery/lifecycle";
import { processPayment } from "../sale/payment";
import { withTx } from "../tx";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "deliveryRemittances", "deliveryConsignments", "deliveryParties", "onlineOrderItems", "onlineOrders",
  "orderPayments", "receptionDraftLines", "receptionDrafts", "auditLogs",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
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
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "cr", name: "مندوب", email: "c@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  // هاتف عراقي مكتمل مطلوب لـ`deferredDirect` (بيع مباشر بلا عربون) — C4 يستعمله.
  await d.insert(s.customers).values([{ id: 1, name: "عميل", phone: "07712345678", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "شركة توصيل", partyType: "COMPANY", defaultFee: "0.00", currentBalance: "0.00", userId: 3 },
  ]);
}
async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}
const LINE20 = { variantId: 1, productUnitId: 1, quantity: "20" }; // 20,000

/** فاتورة استقبال آجلة 20,000 لعميل مسجَّل تُسند لجهة التوصيل داخل التثبيت. */
async function dispatchedCreditInvoice(shiftId: number, reqId: string) {
  const r = await checkoutReception({
    branchId: 1, shiftId, customerId: 1,
    paymentMethod: "CASH", paidAmount: "0",
    clientRequestId: reqId,
    regularSale: { lines: [LINE20], amount: "20000.00" },
    delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
  }, CASHIER);
  const invoiceId = r.regularSale!.invoiceId;
  const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
  return { invoiceId, consignmentId: Number(cn.id), consignmentNumber: cn.consignmentNumber };
}

/** إثبات كشف الشركة: الطرد سُلِّم وقد حصّلت الشركة جزءاً فقط (المتبقّي على العميل). */
async function statementDelivered(consignmentId: number, collectedAmount: string) {
  await confirmConsignmentDelivery(
    {
      consignmentId,
      clientRequestId: `stmt-${consignmentId}`,
      statementWitness: { partyId: 1, statementNumber: "ST-77", collectedAmount },
    },
    { userId: 1 },
  );
}

/** نفس الخطّاف الذي يمرّره الراوتران (sales.pay / reception.collect) حرفياً. */
async function payAtCounter(invoiceId: number, amount: string, shiftId: number, reqId: string) {
  return processPayment(
    {
      invoiceId, amount, method: "CASH", shiftId,
      clientRequestId: reqId,
      preInsertCheck: async (tx) => {
        await assertNoInTransitConsignment(tx, invoiceId);
        await registerCounterCollectionTx(tx, {
          invoiceId, amount, actorUserId: CASHIER.userId, refKey: reqId,
        });
      },
    },
    CASHIER,
  );
}

async function consignment(id: number) {
  return (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, id)))[0];
}
async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
async function partyBalance() {
  const p = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
  return String(p.currentBalance);
}
async function counterLedgerRows(consignmentId: number) {
  return db().select().from(s.deliveryLedgerEntries)
    .where(like(s.deliveryLedgerEntries.eventKey, `CN:${consignmentId}:COUNTER:%`));
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("C1 — كشف جزئي ثم قبض كاونتري للمتبقّي", () => {
  it("12k كشفاً + 8k كاونتراً: فاتورة PAID، تعرّض صفر، سقف التوريد = ما بيد الشركة، عهدة لا تُمسّ", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "c1");
    await statementDelivered(consignmentId, "12000.00");

    // بعد الكشف: الفاتورة سُدّد منها ما حُصِّل فعلاً، والعهدة 12,000 بيد الشركة.
    expect((await invoice(invoiceId)).paidAmount).toBe("12000.00");
    expect(await partyBalance()).toBe("12000.00");

    const res = await payAtCounter(invoiceId, "8000.00", shift.shiftId, "c1-pay");
    expect(res.paidAmount).toBe("20000.00");
    expect(res.status).toBe("PAID");

    const cn = await consignment(consignmentId);
    // التدوين على الإرسالية: سقف التوريد الحيّ = 20,000 − 0 − 8,000 = 12,000 (بيد الشركة فعلاً).
    expect(String(cn.counterSettledAmount)).toBe("8000.00");
    // العهدة المحصَّلة تنتظر التوريد — الإرسالية تبقى مفتوحة ولا يُغلق مالُها.
    expect(cn.status).toBe("DISPATCHED");
    expect(cn.moneyStatus).toBe("UNSETTLED");
    expect(cn.settledAt).toBeNull();
    expect(await partyBalance()).toBe("12000.00"); // النقد الكاونتري لم يمرّ بيد الجهة

    // الدفتر: COD_RELEASED بمفتاح مشتق من مفتاح الدفعة، والتعرّض الإجمالي صفر.
    const rows = await counterLedgerRows(consignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventKey).toBe(`CN:${consignmentId}:COUNTER:c1-pay`);
    expect(rows[0].entryType).toBe("COD_RELEASED");
    expect(String(rows[0].amount)).toBe("8000.00");
    const summary = await getDeliveryFinancialSummary(1);
    expect(summary.codOutstanding).toBe("0.00"); // assigned 20k − collected 12k − released 8k
    expect(summary.cashInCustody).toBe("12000.00");

    // الحدث يحمل مصدر السلطة COUNTER.
    const ev = (await db().select().from(s.deliveryEvents)
      .where(eq(s.deliveryEvents.eventKey, `CN:${consignmentId}:COUNTER:c1-pay`)))[0];
    expect(ev.eventType).toBe("COUNTER_SETTLED");
    expect((ev.payload as { source?: string }).source).toBe("COUNTER");

    // إعادة نفس مفتاح الدفعة (replay) لا تضاعف القبض ولا التدوين.
    const replay = await payAtCounter(invoiceId, "8000.00", shift.shiftId, "c1-pay");
    expect("idempotentReplay" in replay && replay.idempotentReplay).toBe(true);
    expect(String((await consignment(consignmentId)).counterSettledAmount)).toBe("8000.00");
    expect(await counterLedgerRows(consignmentId)).toHaveLength(1);
  });
});

describe("C2 — قبض كاونتري جزئي يتراكم", () => {
  it("3k من متبقّي 8k: الفاتورة PARTIAL وcounterSettledAmount=3000، ثم 5k تكملها PAID", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "c2");
    await statementDelivered(consignmentId, "12000.00");

    await payAtCounter(invoiceId, "3000.00", shift.shiftId, "c2-a");
    expect(String((await consignment(consignmentId)).counterSettledAmount)).toBe("3000.00");
    const inv = await invoice(invoiceId);
    expect(inv.paidAmount).toBe("15000.00");
    expect(inv.status).toBe("PARTIALLY_PAID");

    await payAtCounter(invoiceId, "5000.00", shift.shiftId, "c2-b");
    expect(String((await consignment(consignmentId)).counterSettledAmount)).toBe("8000.00");
    expect((await invoice(invoiceId)).status).toBe("PAID");
    expect(await counterLedgerRows(consignmentId)).toHaveLength(2);
  });
});

describe("C3 — الطرد بالطريق يبقى محجوباً", () => {
  it("ASSIGNED ثم OUT_FOR_DELIVERY: القبض الكاونتري يُرفض كما كان ولا يُدوَّن شيء", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "c3");

    await expect(payAtCounter(invoiceId, "20000.00", shift.shiftId, "c3-a"))
      .rejects.toThrow(/بالطريق مع المندوب/);

    for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
      await transitionConsignmentParcel(
        { consignmentId, toStatus, clientRequestId: `c3-${toStatus}` },
        { userId: 3 },
      );
    }
    await expect(payAtCounter(invoiceId, "20000.00", shift.shiftId, "c3-b"))
      .rejects.toThrow(/بالطريق مع المندوب/);

    expect((await invoice(invoiceId)).paidAmount).toBe("0.00");
    expect(String((await consignment(consignmentId)).counterSettledAmount)).toBe("0.00");
    expect(await counterLedgerRows(consignmentId)).toHaveLength(0);
  });
});

describe("C4 — فاتورة بلا إرسالية لا تتأثر", () => {
  it("القبض يمرّ بلا أيّ قيد أو حدث توصيلي", async () => {
    const shift = await openReception();
    // بيع مباشر آجل (بلا توصيل، بلا دفع فوري) — deferredDirect يسمح بpaidAmount=0 على بيعٍ مباشر.
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "c4",
      deferredDirect: true,
      regularSale: { lines: [LINE20], amount: "20000.00" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;

    const res = await payAtCounter(invoiceId, "20000.00", shift.shiftId, "c4-pay");
    expect(res.status).toBe("PAID");
    expect(await db().select().from(s.deliveryLedgerEntries)).toHaveLength(0);
    expect(await db().select().from(s.deliveryEvents)).toHaveLength(0);
  });
});

describe("C5 — idempotency على refKey", () => {
  it("نفس refKey مرّتين: الأولى تُدوّن والثانية no-op (تدوينة واحدة)", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "c5");
    await statementDelivered(consignmentId, "12000.00");

    const first = await withTx((tx) => registerCounterCollectionTx(tx, {
      invoiceId, amount: "2000.00", actorUserId: 2, refKey: "c5-key",
    }));
    expect(first?.applied).toBe("2000.00");
    const second = await withTx((tx) => registerCounterCollectionTx(tx, {
      invoiceId, amount: "2000.00", actorUserId: 2, refKey: "c5-key",
    }));
    expect(second).toBeNull();

    expect(String((await consignment(consignmentId)).counterSettledAmount)).toBe("2000.00");
    expect(await counterLedgerRows(consignmentId)).toHaveLength(1);
  });
});

describe("C6 — الإثبات المستندي بلا أيّ تحصيل: الكاونتر يغلق الإرسالية نهائياً", () => {
  it("طرد سُلّم (بلا عهدة) + سداد كاونتري كامل ⇒ SETTLED ولا شيء يُورَّد", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "c6");
    // محاكاة قناة الفعل المستنديّ (شريحة موازية): ثبت التسليم دون أن تمرّ قيمةٌ بيد الجهة.
    await db().update(s.deliveryConsignments)
      .set({ parcelStatus: "DELIVERED", courierDeliveredAt: new Date() })
      .where(eq(s.deliveryConsignments.id, consignmentId));

    const res = await payAtCounter(invoiceId, "20000.00", shift.shiftId, "c6-pay");
    expect(res.status).toBe("PAID");

    const cn = await consignment(consignmentId);
    expect(String(cn.counterSettledAmount)).toBe("20000.00");
    expect(cn.status).toBe("DELIVERED");
    expect(cn.moneyStatus).toBe("SETTLED");
    expect(cn.settledAt).not.toBeNull();

    // لا تعرّض ولا عهدة ولا ذمّة — الدينار كامل المسار: إيصال درج + قيد + تحرير تعرّض.
    const summary = await getDeliveryFinancialSummary(1);
    expect(summary.codOutstanding).toBe("0.00");
    expect(summary.cashInCustody).toBe("0.00");
    expect(await partyBalance()).toBe("0.00");
    expect((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance).toBe("0.00");
  });
});
