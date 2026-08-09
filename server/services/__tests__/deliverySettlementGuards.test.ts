/**
 * حوكمة تسوية التوصيل (٩/٨) — ثوابت «لا دينار يضيع بصمت أو ليس له مسار أو تبويب»:
 *
 *  G1 — حارس «الإرسالية بالطريق» على مسار sales.pay (كان على مسار الاستقبال وحده):
 *       تسديدٌ كاونتريّ لفاتورةٍ بيد مندوب = عهدة شبح ⇒ يُرفض.
 *  G2 — التسوية الحرّة (settle) محصورة بالعهدة السائبة: نقد الإرساليات المفتوحة يُورَّد
 *       بالإرسالية كي تُقيَّد فاتورته (كان زرّ «تسوية» يصفّر العهدة ويترك الفاتورة معلّقة للأبد).
 *  G3 — الشطب الموجَّه يقفل القصّة الثلاثية: إرسالية WRITTEN_OFF + فاتورة مسدَّدة + ذمّة
 *       عميل مُبرَّأة + خسارة مقيَّدة — ولا توريد لاحق يقلب الرصيد سالباً.
 *  G4 — استرداد عجز مشطوب: النقد يدخل الدرج والخسارة تُعكَس وΣ(WRITEOFF)=0 والرصيد لا يمسّ.
 *  G5 — سطر التوريد الصفريّ يُستثنى: لا يقلب DISPATCHED إلى PARTIAL كاذبة (كان يقفل باب الإرجاع).
 *  G6 — idempotency الشطب بpayloadHash: نفس المفتاح بمبلغ مختلف = CONFLICT لا نجاح صامت.
 *  G7 — لا ازدواج عهدة عبر القناتين: فاتورة ONLINE لا تُسنَد إرساليةً، وتأكيد المندوب يرفض
 *       فاتورةً لها إرسالية استقبال.
 *  G8 — أمانة COUNTER لأمر شغل بلا إيصال قبض فعليّ لا تُصرف (OUT بلا IN = مال المكتبة يضيع).
 *  G9 — التقاط الأمانة محروس خادمياً: بلا توصيل COUNTER أو بمبلغ يخالف الأجرة ⇒ يُرفض.
 *  G10 — كشف حساب العميل يُظهر دفعة توريد المندوب (كانت غائبة ⇒ كشف يطالب من سدّد).
 *  G11 — توريد إرسالية COUNTER قديمة (feeSettledAt=null): قيد التبرئة سالب (Σ FEE_HELD تتّجه للصفر).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { recoverDeliveryWriteOff, settleDeliveryBalance, writeOffDeliveryShortfall } from "../delivery/settle";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { dispatchToDelivery } from "../delivery/dispatch";
import { confirmCourierDelivery } from "../delivery/courier";
import { assertNoInTransitConsignment } from "../delivery/guards";
import { processPayment } from "../sale/payment";
import { getCustomerStatement } from "../reports/arAging";

const TABLES = [
  "deliveryRemittances", "deliveryConsignments", "deliveryParties", "onlineOrderItems", "onlineOrders",
  "orderPayments", "receptionDraftLines", "receptionDrafts", "auditLogs",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

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
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  await d.insert(s.deliveryParties).values([
    { id: 1, name: "مندوب", partyType: "INDIVIDUAL", defaultFee: "0.00", currentBalance: "0.00", userId: 3 },
  ]);
}
async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}
const LINE = { variantId: 1, productUnitId: 1, quantity: "10" }; // 10,000

/** فاتورة استقبال آجلة لعميل مسجَّل تُسند لمندوب داخل التثبيت — عهدة 10,000. */
async function dispatchedCreditInvoice(shiftId: number, reqId: string) {
  const r = await checkoutReception({
    branchId: 1, shiftId, customerId: 1,
    paymentMethod: "CASH", paidAmount: "0",
    clientRequestId: reqId,
    regularSale: { lines: [LINE], amount: "10000.00" },
    delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
  }, CASHIER);
  const invoiceId = r.regularSale!.invoiceId;
  const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
  return { invoiceId, consignmentId: Number(cn.id), consignmentNumber: cn.consignmentNumber };
}

async function partyBalance() {
  const p = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
  return String(p.currentBalance);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("G1 — حارس «بالطريق مع المندوب» يشمل sales.pay", () => {
  it("تسديد كاونتري لفاتورة بيد مندوب يُرفض (نفس preInsertCheck الذي يمرّره الراوتر)", async () => {
    const shift = await openReception();
    const { invoiceId } = await dispatchedCreditInvoice(shift.shiftId, "g1");
    await expect(
      processPayment(
        {
          invoiceId, amount: "10000.00", method: "CASH", shiftId: shift.shiftId,
          clientRequestId: "g1-pay",
          preInsertCheck: (tx) => assertNoInTransitConsignment(tx, invoiceId),
        },
        CASHIER,
      ),
    ).rejects.toThrow(/بالطريق مع المندوب/);
    // العهدة والفاتورة لم تُمسّا.
    expect(await partyBalance()).toBe("10000.00");
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(inv.paidAmount).toBe("0.00");
  });
});

describe("G2 — التسوية الحرّة محصورة بالعهدة السائبة", () => {
  it("عهدة مدعومة بإرسالية مفتوحة تُرفض تسويتها الحرّة، والسائبة تمرّ", async () => {
    // عهدة سائبة تاريخية 3,000 (نمط تحصيلات متجر/عجز قديم) + إرسالية مفتوحة 10,000.
    await db().update(s.deliveryParties).set({ currentBalance: "3000.00" }).where(eq(s.deliveryParties.id, 1));
    const shift = await openReception();
    await dispatchedCreditInvoice(shift.shiftId, "g2");
    expect(await partyBalance()).toBe("13000.00");

    await expect(
      settleDeliveryBalance({ branchId: 1, partyId: 1, amount: "5000.00", clientRequestId: "g2-a" }, CASHIER),
    ).rejects.toThrow(/السائبة/);

    const ok = await settleDeliveryBalance({ branchId: 1, partyId: 1, amount: "3000.00", clientRequestId: "g2-b" }, CASHIER);
    expect(ok.partyBalanceAfter).toBe("10000.00");
  });
});

describe("G3 — الشطب الموجَّه يقفل الإرسالية والفاتورة وذمّة العميل معاً", () => {
  it("شطب إرسالية بكامل متبقّيها: WRITTEN_OFF + فاتورة PAID + ذمّة صفر + خسارة — والتوريد اللاحق يُرفض", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "g3");
    // البيع الآجل رفع ذمّة العميل.
    const cBefore = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cBefore.currentBalance).toBe("10000.00");

    // الشطب الجزئي للإرسالية مرفوض (المُحصَّل جزئياً يُورَّد أولاً).
    await expect(
      writeOffDeliveryShortfall({ branchId: 1, partyId: 1, amount: "4000.00", reason: "ضياع نقد", consignmentId, clientRequestId: "g3-p" }, MANAGER),
    ).rejects.toThrow(/بكامل متبقّيها/);

    const res = await writeOffDeliveryShortfall(
      { branchId: 1, partyId: 1, amount: "10000.00", reason: "المندوب ضيّع النقد", consignmentId, clientRequestId: "g3" },
      MANAGER,
    );
    expect(res.partyBalanceAfter).toBe("0.00");

    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, consignmentId)))[0];
    expect(cn.status).toBe("WRITTEN_OFF");
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(inv.paidAmount).toBe("10000.00");
    expect(inv.status).toBe("PAID");
    const cAfter = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cAfter.currentBalance).toBe("0.00");
    const loss = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DELIVERY_WRITEOFF")))[0];
    expect(String(loss.amount)).toBe("10000.00");
    expect(String(loss.cost)).toBe("10000.00");

    // «وجد المندوب النقد» لا يمرّ توريداً — الإرسالية مغلقة (كان يقلب الرصيد −10,000).
    await expect(
      recordDeliveryRemittance(
        { branchId: 1, partyId: 1, lines: [{ consignmentId, collectedAmount: "10000.00" }], countedCash: "10000.00", clientRequestId: "g3-r" },
        CASHIER,
      ),
    ).rejects.toThrow(/غير قابلة للتسوية/);
  });

  it("الشطب المجمّع محصور بالعهدة السائبة (إرسالية حيّة لا يُخفى عجزها بشطب أعمى)", async () => {
    const shift = await openReception();
    await dispatchedCreditInvoice(shift.shiftId, "g3b");
    await expect(
      writeOffDeliveryShortfall({ branchId: 1, partyId: 1, amount: "10000.00", reason: "بلا إرسالية" }, MANAGER),
    ).rejects.toThrow(/السائبة/);
  });
});

describe("G4 — استرداد عجز مشطوب", () => {
  it("النقد يدخل الدرج، الخسارة تُعكَس (Σ WRITEOFF=0)، الرصيد لا يُمسّ، والسقف = صافي المشطوب", async () => {
    const shift = await openReception();
    const { consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "g4");
    await writeOffDeliveryShortfall(
      { branchId: 1, partyId: 1, amount: "10000.00", reason: "ضياع", consignmentId, clientRequestId: "g4-w" },
      MANAGER,
    );

    // استرداد فوق المشطوب يُرفض.
    await expect(
      recoverDeliveryWriteOff({ branchId: 1, partyId: 1, amount: "15000.00", clientRequestId: "g4-x" }, MANAGER),
    ).rejects.toThrow(/يتجاوز صافي المشطوب/);

    const r = await recoverDeliveryWriteOff({ branchId: 1, partyId: 1, amount: "10000.00", clientRequestId: "g4-r" }, MANAGER);
    expect(r.recovered).toBe("10000.00");
    expect(await partyBalance()).toBe("0.00");
    // Σ(DELIVERY_WRITEOFF) صفر ⇒ P&L لم يعُد يحمل خسارةً عن دينارٍ وصل.
    const woNet = (await db()
      .select({ v: sql<string>`COALESCE(SUM(${s.accountingEntries.amount}), 0)` })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DELIVERY_WRITEOFF")))[0];
    expect(Number(woNet.v)).toBe(0);
    // النقد في الدرج بإيصال IN.
    const rin = (await db().select().from(s.receipts)
      .where(eq(s.receipts.referenceNumber, "DLV-RECOVER-1")))[0];
    expect(rin).toBeTruthy();
    expect(String(rin.amount)).toBe("10000.00");
    expect(rin.direction).toBe("IN");
  });
});

describe("G5 — سطر التوريد الصفري يُستثنى", () => {
  it("توريد بسطرين (محصَّل + صفري): الصفري يبقى DISPATCHED بلا remittanceId، وكل الأسطر صفرية تُرفض", async () => {
    const shift = await openReception();
    const a = await dispatchedCreditInvoice(shift.shiftId, "g5-a");
    const b = await dispatchedCreditInvoice(shift.shiftId, "g5-b");

    await expect(
      recordDeliveryRemittance(
        { branchId: 1, partyId: 1, lines: [{ consignmentId: b.consignmentId, collectedAmount: "0" }], countedCash: "0.00", clientRequestId: "g5-z" },
        CASHIER,
      ),
    ).rejects.toThrow(/كل الأسطر صفرية/);

    await recordDeliveryRemittance(
      {
        branchId: 1, partyId: 1,
        lines: [
          { consignmentId: a.consignmentId, collectedAmount: "10000.00" },
          { consignmentId: b.consignmentId, collectedAmount: "0" },
        ],
        countedCash: "10000.00", clientRequestId: "g5-r",
      },
      CASHIER,
    );
    const cnA = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, a.consignmentId)))[0];
    const cnB = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, b.consignmentId)))[0];
    expect(cnA.status).toBe("DELIVERED");
    expect(cnB.status).toBe("DISPATCHED"); // كان ينقلب PARTIAL كاذبة تقفل باب الإرجاع
    expect(cnB.remittanceId).toBeNull();
    expect(await partyBalance()).toBe("10000.00"); // عهدة b باقية كما هي
  });
});

describe("G6 — idempotency الشطب بpayloadHash", () => {
  it("نفس المفتاح بمبلغ مختلف = CONFLICT (كان نجاحاً صامتاً بلا تطبيق)", async () => {
    await db().update(s.deliveryParties).set({ currentBalance: "20000.00" }).where(eq(s.deliveryParties.id, 1));
    await writeOffDeliveryShortfall({ branchId: 1, partyId: 1, amount: "5000.00", reason: "عجز قديم", clientRequestId: "g6" }, MANAGER);
    await expect(
      writeOffDeliveryShortfall({ branchId: 1, partyId: 1, amount: "8000.00", reason: "عجز قديم", clientRequestId: "g6" }, MANAGER),
    ).rejects.toThrow();
    // الشطب الفعلي بقي 5,000 فقط.
    expect(await partyBalance()).toBe("15000.00");
  });
});

describe("G7 — لا ازدواج عهدة بين قناة المتجر وقناة الإرساليات", () => {
  it("فاتورة ONLINE لا تُسنَد إرساليةً من مسار الاستقبال", async () => {
    // فاتورة متجر (sourceType ONLINE) مُنشأة مباشرةً — يكفي رأس الفاتورة لحارس المصدر.
    await db().insert(s.invoices).values({
      id: 501, invoiceNumber: "INV-ON-1", sourceType: "ONLINE", branchId: 1, customerId: 1,
      priceTier: "RETAIL", subtotal: "10000.00", total: "10000.00", costTotal: "5000.00",
      status: "PENDING", paidAmount: "0.00", createdBy: 1,
    });
    await expect(
      dispatchInvoiceToDelivery({ invoiceId: 501, partyId: 1, clientRequestId: "g7-a" }, MANAGER),
    ).rejects.toThrow(/طلب متجر/);
  });

  it("تأكيد المندوب يرفض فاتورةً لها إرسالية استقبال (بيانات ملتفّة/قديمة)", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentNumber } = await dispatchedCreditInvoice(shift.shiftId, "g7-b");
    // طلب متجر يشير لنفس الفاتورة (حالة التفاف API/بيانات قديمة).
    await db().insert(s.onlineOrders).values({
      id: 700, orderNumber: "ORD-700", customerId: 1, branchId: 1, invoiceId,
      subtotal: "10000.00", total: "10000.00", status: "SHIPPED", deliveryPartyId: 1,
    });
    await expect(
      confirmCourierDelivery({ onlineOrderId: 700 }, { userId: 3 }),
    ).rejects.toThrow(new RegExp(consignmentNumber));
    // العهدة بقيت 10,000 (لم تتضاعف).
    expect(await partyBalance()).toBe("10000.00");

    // وبعد توريد الإرسالية (مغلقة DELIVERED): التأكيد يمرّ ختماً تشغيلياً بصفر تحصيل —
    // الحارس على المفتوحة فقط (كان الرفض الأعمى يقفل ختم DELIVERED على طلبٍ سُلِّم فعلاً).
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    await recordDeliveryRemittance(
      { branchId: 1, partyId: 1, lines: [{ consignmentId: Number(cn.id), collectedAmount: "10000.00" }], countedCash: "10000.00", clientRequestId: "g7-c" },
      CASHIER,
    );
    const ok = await confirmCourierDelivery({ onlineOrderId: 700 }, { userId: 3 });
    expect(ok.collected).toBe("0.00"); // لا ازدواج — التحصيل مشتق من متبقّي الفاتورة (صفر)
    expect(await partyBalance()).toBe("0.00");
    const order = (await db().select().from(s.onlineOrders).where(eq(s.onlineOrders.id, 700)))[0];
    expect(order.status).toBe("DELIVERED");
  });
});

describe("G8 — أمانة COUNTER لأمر شغل تُقاس بإيصالات القبض الفعلية", () => {
  it("أمر شغل COUNTER بلا إيصال DLV-FEE-WO ⇒ الإرسال يُرفض (كان يصرف OUT بلا IN)", async () => {
    await db().insert(s.workOrders).values({
      id: 900, orderNumber: "WO-900", title: "طباعة", branchId: 1, customerId: 1,
      status: "READY", hasDelivery: true, quantity: 1,
      salePrice: "10000.00", materialsCost: "0.00", laborCost: "0.00", deposit: "0.00",
      deliveryFeeCollection: "COUNTER", deliveryCost: "5000.00",
      deliveryAddress: "بغداد", createdBy: 2,
    });
    await expect(
      dispatchToDelivery({ workOrderId: 900, partyId: 1, deliveryFee: "5000.00", clientRequestId: "g8" }, CASHIER),
    ).rejects.toThrow(/بلا إيصال قبض أمانة/);
  });
});

describe("G9 — التقاط أمانة الأجرة محروس خادمياً", () => {
  it("مع توصيل COURIER يُرفض، وبمبلغ يخالف أجرة COUNTER يُرفض، وبلا توصيل (إسناد مؤجَّل) يمرّ", async () => {
    const shift = await openReception();
    // (أ) أمانة مع توصيل يقبض المندوب أجرته بنفسه = المندوب يقبضها مرتين ⇒ رفض.
    await expect(
      checkoutReception({
        branchId: 1, shiftId: shift.shiftId, customerId: 1,
        paymentMethod: "CASH", paidAmount: "10000.00",
        deliveryFeeHeld: "5000.00",
        clientRequestId: "g9-a",
        regularSale: { lines: [LINE], amount: "10000.00" },
        delivery: { partyId: 1, fee: "5000.00", feeCollection: "COURIER" },
      }, CASHIER),
    ).rejects.toThrow(/مقبوضة في الاستقبال/);

    // (ب) أمانة تخالف أجرة COUNTER ⇒ رفض (الفرق كان يعلق في الدرج بلا مسار ردّ).
    await expect(
      checkoutReception({
        branchId: 1, shiftId: shift.shiftId, customerId: 1,
        paymentMethod: "CASH", paidAmount: "10000.00",
        deliveryFeeHeld: "5000.00",
        clientRequestId: "g9-b",
        regularSale: { lines: [LINE], amount: "10000.00" },
        delivery: { partyId: 1, fee: "3000.00", feeCollection: "COUNTER" },
      }, CASHIER),
    ).rejects.toThrow(/يجب أن تساوي/);

    // (ج) بلا توصيلٍ في التثبيت = الإسناد المؤجَّل من الطابور (ش٦/V15) — مشروع: الإيصال
    // يُكتب الآن وdispatchInvoice يفرض المساواة لحظة الإسناد.
    const ok = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "10000.00",
      deliveryFeeHeld: "5000.00",
      clientRequestId: "g9-c",
      regularSale: { lines: [LINE], amount: "10000.00" },
    }, CASHIER);
    const invoiceId = ok.regularSale!.invoiceId;
    const held = (await db().select().from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `DLV-FEE-INV-${invoiceId}`)))[0];
    expect(held).toBeTruthy();
    expect(String(held.amount)).toBe("5000.00");
    expect(held.direction).toBe("IN");
  });
});

describe("G10 — كشف حساب العميل يرى دفعة توريد المندوب", () => {
  it("بعد التوريد: الفاتورة مسدَّدة، ذمّة العميل صفر، والكشف يعرض دفعة COD بمبلغها", async () => {
    const shift = await openReception();
    const { consignmentId, invoiceId } = await dispatchedCreditInvoice(shift.shiftId, "g10");
    await recordDeliveryRemittance(
      { branchId: 1, partyId: 1, lines: [{ consignmentId, collectedAmount: "10000.00" }], countedCash: "10000.00", clientRequestId: "g10-r" },
      CASHIER,
    );
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(c.currentBalance).toBe("0.00");

    const st = await getCustomerStatement(1);
    expect(st).toBeTruthy();
    const codPay = st!.payments.find((p) => p.paymentMethod === "COD" && p.invoiceId === invoiceId);
    expect(codPay).toBeTruthy();
    expect(codPay!.amount).toBe("10000.00");
  });
});

describe("G12 — الحزام الثاني للشطب الموجَّه: القيد المالي مسقوف بمتبقّي الفاتورة الحيّ", () => {
  it("انحراف تاريخي (returnedTotal بعد الإسناد): paidAmount لا يتجاوز الصافي وذمّة العميل لا تنقلب سالبة والخسارة على الجزء الحقيقي وحده", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "g12");
    // محاكاة انحراف قديم: مرتجع 3,000 سُجِّل بمسارٍ لم يخفض codAmount (بيانات ما قبل الإصلاح).
    await db().update(s.invoices).set({ returnedTotal: "3000.00" }).where(eq(s.invoices.id, invoiceId));
    await db().update(s.customers).set({ currentBalance: "7000.00" }).where(eq(s.customers.id, 1));

    await writeOffDeliveryShortfall(
      { branchId: 1, partyId: 1, amount: "10000.00", reason: "ضياع نقد بعد انحراف", consignmentId, clientRequestId: "g12-w" },
      MANAGER,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    // الصافي الحيّ كان 7,000 (10,000 − 3,000 مرتجع) ⇒ القيد يقف عنده لا عند متبقّي الإرسالية.
    expect(inv.paidAmount).toBe("7000.00");
    expect(inv.status).toBe("PAID");
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(c.currentBalance).toBe("0.00"); // لا ذمّة سالبة
    // العهدة صُفّيت بالكامل (10,000) والخسارة الحقيقية 7,000 فقط.
    expect(await partyBalance()).toBe("0.00");
    const loss = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DELIVERY_WRITEOFF")))[0];
    expect(String(loss.amount)).toBe("10000.00");
    expect(String(loss.cost)).toBe("7000.00");
  });
});

describe("G13 — codAmount عند إسناد فاتورة يطرح المرتجعات", () => {
  it("فاتورة عليها مرتجع جزئي قبل الإسناد ⇒ العهدة بالصافي الحيّ لا بالإجمالي", async () => {
    // رأس فاتورة مباشرةً (حارس الإسناد يقرأ الرأس فقط) — عليها مرتجع 3,000 سابق للإسناد.
    await db().insert(s.invoices).values({
      id: 601, invoiceNumber: "INV-G13-1", sourceType: "POS", branchId: 1, customerId: 1,
      priceTier: "RETAIL", subtotal: "10000.00", total: "10000.00", costTotal: "5000.00",
      status: "PENDING", paidAmount: "0.00", returnedTotal: "3000.00", createdBy: 1,
    });
    const d = await dispatchInvoiceToDelivery({ invoiceId: 601, partyId: 1, clientRequestId: "g13-d" }, MANAGER);
    expect(d.codAmount).toBe("7000.00");
    expect(await partyBalance()).toBe("7000.00");
  });
});

describe("G14 — استرداد العجز المشطوب محصور بفرع الشطب", () => {
  it("شُطب على الفرع ١ ⇒ الاسترداد من فرعٍ آخر يُرفض (عكس الخسارة يقع حيث وقعت)", async () => {
    const shift = await openReception();
    const { consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "g14");
    await writeOffDeliveryShortfall(
      { branchId: 1, partyId: 1, amount: "10000.00", reason: "ضياع", consignmentId, clientRequestId: "g14-w" },
      MANAGER,
    );
    await expect(
      recoverDeliveryWriteOff({ branchId: 2, partyId: 1, amount: "10000.00", clientRequestId: "g14-r" }, MANAGER),
    ).rejects.toThrow(/على هذا الفرع/);
  });
});

describe("G11 — توريد إرسالية COUNTER قديمة يقيّد التبرئة سالبة", () => {
  it("feeSettledAt=null + أجرة 3,000: قيد FEE_HELD في التوريد = −3,000 (كان +3,000 ينسف Σ=0)", async () => {
    const shift = await openReception();
    const { invoiceId, consignmentId } = await dispatchedCreditInvoice(shift.shiftId, "g11");
    // محاكاة إرسالية قديمة سابقة لتوحيد settleFeeNow: أجرة COUNTER لم تُصرف عند الإرسال.
    await db().update(s.deliveryConsignments)
      .set({ feeCollection: "COUNTER", deliveryFee: "3000.00", feeSettledAt: null })
      .where(eq(s.deliveryConsignments.id, consignmentId));

    await recordDeliveryRemittance(
      { branchId: 1, partyId: 1, lines: [{ consignmentId, collectedAmount: "10000.00" }], countedCash: "7000.00", clientRequestId: "g11-r" },
      CASHIER,
    );
    const held = (await db().select().from(s.accountingEntries)
      .where(and(
        eq(s.accountingEntries.entryType, "DELIVERY_FEE_HELD"),
        eq(s.accountingEntries.invoiceId, invoiceId),
      )))[0];
    expect(held).toBeTruthy();
    expect(String(held.amount)).toBe("-3000.00");
  });
});
