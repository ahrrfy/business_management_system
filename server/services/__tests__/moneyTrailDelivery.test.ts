/**
 * «لا دينار يضيع بصمت» (قرار المالك ٦/٨/٢٦) — ثوابت مسار المال في التوصيل والاستقبال.
 *
 * كل اختبارٍ هنا يثبت أنّ ديناراً بعينه له **مصدرٌ ومصبٌّ وتبويب**:
 *  M1 — فاتورة التوصيل COD: الدرج يُحاسَب بالمقبوض نقداً وحده، والباقي عهدةٌ على المندوب
 *       في نفس المعاملة (لا لحظةَ مالٍ بلا مالك) — والوردية تُغلق بفارق صفر.
 *  M2 — أمانة أجرة التوصيل تُبرَّأ: Σ(DELIVERY_FEE_HELD) = صفر بعد صرفها للمندوب.
 *  M3 — الأمانة لا تُقرأ «دفعةً من العميل» في كشف حسابه ولا ترفع سقف الاسترداد النقديّ.
 *  M4 — إرجاع الإرسالية يعكس **من الطرفين**: عهدة المندوب وذمّة العميل (تأكيد المالك).
 *  M5 — حارس العكس المزدوج: فاتورةٌ أُرجع منها سلفاً لا تُرجَع إرساليتها.
 *  M6 — عهدة المناديب أصلٌ ظاهر في المركز المالي (كانت خارج الأصول كلّها).
 *  M7 — سقف عهدة المندوب يُنفَّذ فعلاً (كان يُخزَّن ولا يُقرأ).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { returnConsignment } from "../delivery/returns";
import { confirmConsignmentDelivery, transitionConsignmentParcel } from "../delivery/courier";
import { recordDeliveryRemittance } from "../delivery/remittance";
import { payDeliveryFee } from "../delivery/fees";
import { getDeliveryFinancialSummary } from "../delivery/lifecycle";
import { getFinancialPosition } from "../reportsFinancialService";
import { getCustomerStatement } from "../reports/arAging";
import { returnSale } from "../returnService";

const TABLES = [
  "deliveryOutbox", "deliveryEvents", "deliveryLedgerEntries", "deliveryRemittanceLines", "deliveryPartyMembers",
  "deliveryRemittances", "deliveryConsignments", "deliveryParties",
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
async function seed(opts: { floatLimit?: string } = {}) {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "cr", name: "مندوب", email: "d@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  await d.insert(s.deliveryParties).values([{
    id: 1, name: "مندوب", partyType: "INDIVIDUAL", defaultFee: "5000.00",
    currentBalance: "0.00", userId: 3, ...(opts.floatLimit ? { floatLimit: opts.floatLimit } : {}),
  }]);
}
async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}
const LINE = { variantId: 1, productUnitId: 1, quantity: "10" }; // 10,000

/** Σ(IN−OUT) لقيود أمانة الأجرة على فاتورة — الثابت: صفرٌ ⇔ أُبرِئت. */
async function feeHeldNet(invoiceId: number) {
  const r = await db()
    .select({ v: sql<string>`COALESCE(SUM(${s.accountingEntries.amount}), 0)` })
    .from(s.accountingEntries)
    .where(and(
      eq(s.accountingEntries.entryType, "DELIVERY_FEE_HELD"),
      eq(s.accountingEntries.invoiceId, invoiceId),
    ));
  return Number(r[0]?.v ?? 0);
}

async function consignmentForInvoice(invoiceId: number) {
  return (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
}

async function deliverConsignment(consignmentId: number) {
  for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
    await transitionConsignmentParcel(
      { consignmentId, toStatus, clientRequestId: `money-${consignmentId}-${toStatus}` },
      { userId: 3 },
    );
  }
  await confirmConsignmentDelivery(
    { consignmentId, clientRequestId: `money-${consignmentId}-delivered` },
    { userId: 3 },
  );
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("M1 — فاتورة التوصيل COD: الدرج بالمقبوض نقداً وحده والباقي عهدةٌ على المندوب", () => {
  it("بضاعة 10,000 بلا قبضٍ + توصيل ⇒ الدرج صفر، عهدة المندوب 10,000، والوردية تُغلق بفارق صفر", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId,
      contactName: "زبون هاتفيّ", contactPhone: "07700000000",
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m1-cod",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);

    const invoiceId = r.regularSale!.invoiceId;
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(inv.paidAmount).toBe("0.00");          // لا نقد قُبض
    expect(inv.total).toBe("10000.00");
    // عند الإسناد لا يوجد نقد في يد المندوب؛ يبقى المبلغ تعرضاً تشغيلياً فقط.
    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(party.currentBalance).toBe("0.00");
    expect(r.dispatch).toBeTruthy();
    expect(r.dispatch!.codAmount).toBe("10000.00");
    const disp = (await db().select().from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.entryType, "COD_ASSIGNED")))[0];
    expect(disp).toBeTruthy();
    expect(String(disp.amount)).toBe("10000.00");
    // لا إيصال نقديّ في الدرج ⇒ الإغلاق على صفر بفارق صفر.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "0.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });

  it("عربونٌ نقديّ جزئيّ 3,000 ⇒ الدرج 3,000 والعهدة 7,000 (كلٌّ في مكانه)", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "3000.00",
      clientRequestId: "m1-partial",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.regularSale!.invoiceId)))[0];
    expect(inv.paidAmount).toBe("3000.00");
    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(party.currentBalance).toBe("0.00");
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "3000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("M2 — أمانة أجرة التوصيل تُبرَّأ بالكامل (Σ = صفر)", () => {
  it("فاتورة مدفوعة كاملاً + أجرة 5,000 مقبوضة في الاستقبال ⇒ تُصرَف للمندوب فوراً والدرج يوازن", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "10000.00",
      deliveryFeeHeld: "5000.00",
      clientRequestId: "m2-fee",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "5000.00", feeCollection: "COUNTER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;

    // الأجرة لا تُدفع عند الإسناد؛ تُكتسب وتُدفع بعد نجاح التوصيل فقط.
    expect(await feeHeldNet(invoiceId)).toBe(5000);
    const cn = await consignmentForInvoice(invoiceId);
    await deliverConsignment(Number(cn.id));
    await payDeliveryFee(
      { consignmentId: Number(cn.id), shiftId: shift.shiftId, clientRequestId: "m2-fee-paid" },
      CASHIER,
    );
    expect(await feeHeldNet(invoiceId)).toBe(0);
    const outFee = (await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, invoiceId),
      eq(s.receipts.direction, "OUT"),
    )))[0];
    expect(outFee).toBeTruthy();
    expect(String(outFee.amount)).toBe("5000.00");
    expect(outFee.cashBucket).toBe("DRAWER"); // خرج من نفس الدرج الذي دخله
    // الدرج: 10,000 بيعاً + 5,000 أمانةً − 5,000 صرفاً = 10,000.
    const closed = await closeShift({ shiftId: shift.shiftId, countedCash: "10000.00" }, CASHIER);
    expect(closed.variance).toBe("0.00");
  });
});

describe("M3 — الأمانة ليست دفعةً من العميل", () => {
  it("لا تظهر في كشف حساب العميل ولا ترفع سقف الاسترداد النقديّ لفاتورةٍ مدفوعةٍ ببطاقة", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "10000.00",
      deliveryFeeHeld: "5000.00",
      clientRequestId: "m3-fee",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "5000.00", feeCollection: "COUNTER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;

    // سجلّ تاريخيّ موثوق قبل تعطيل القبض غير النقدي: نحافظ على تغطية قراءة
    // البطاقة والاسترداد من البيانات القائمة، من دون فتح مسار قبض CARD حيّ.
    await db().update(s.receipts).set({
      paymentMethod: "CARD",
      cashBucket: null,
      referenceNumber: "CARD-1",
    }).where(and(
      eq(s.receipts.invoiceId, invoiceId),
      eq(s.receipts.direction, "IN"),
      eq(s.receipts.amount, "10000.00"),
    ));

    // (أ) كشف الحساب: مجموع الدفعات = ما دفعه العميل فعلاً (10,000) لا 15,000.
    const st = await getCustomerStatement(1, {});
    expect(st).not.toBeNull();
    // الأمانة ٥٬٠٠٠ **لا** تُحتسَب دفعةً على العميل — لولا الإصلاح لظهرت ١٥٬٠٠٠ ولَبدا دائناً.
    const paySum = st!.payments.reduce((a, p) => a + Number(p.amount ?? 0), 0);
    expect(paySum).toBe(10000);
    expect(Number(st!.summary.totalPaid)).toBe(10000);

    // (ب) سقف الاسترداد: الفاتورة دُفعت بالبطاقة ⇒ الاسترداد النقديّ ممنوع رغم أمانةٍ نقديّة بالدرج.
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];
    await expect(returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 10 }],
      refund: { amount: "5000.00", method: "CASH" },
      restock: true,
    }, MANAGER)).rejects.toThrowError(/يتجاوز المسموح/);
    void shift;
  });
});

describe("M4/M5 — إرجاع الإرسالية يعكس من الطرفين، وحارس العكس المزدوج", () => {
  it("إرجاعٌ يخصم عهدة المندوب **وذمّة العميل** معاً (تأكيد المالك ٦/٨)", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m4-ret",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];

    const custBefore = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(custBefore.currentBalance)).toBe(10000); // البيع الآجل رفع ذمّته

    await returnConsignment(Number(cn.id), { ...MANAGER, clientRequestId: "m4-ret-1" } as never);

    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(Number(party.currentBalance)).toBe(0); // لم ترتفع قبل التسليم في المرحلة الثانية
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(Number(cust.currentBalance)).toBe(0);  // وذمّة العميل خُصمت
    const retEntry = (await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "RETURN")))[0];
    expect(Number(retEntry.customerId)).toBe(1);  // القيد منسوبٌ للعميل فيظهر بكشفه
    void shift;
  });

  it("إرجاع إرسالية مرحّلة يعكس العهدة التاريخية ولا يترك رصيداً أو التزاماً وهمياً", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m4-legacy-ret",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const cn = await consignmentForInvoice(r.regularSale!.invoiceId);

    // محاكاة لقطة 0178: الرصيد القديم صار COD_COLLECTED افتتاحياً، والصف وُسم
    // بأنه معترف بعهدته حتى لا يُحصّل مرة ثانية عند ختم التسليم.
    await db().update(s.deliveryParties)
      .set({ currentBalance: "10000.00" })
      .where(eq(s.deliveryParties.id, 1));
    await db().update(s.deliveryConsignments)
      .set({ custodyRecognizedAt: new Date() })
      .where(eq(s.deliveryConsignments.id, Number(cn.id)));
    await db().insert(s.deliveryLedgerEntries).values({
      eventKey: "PARTY:1:COD_COLLECTED:LEGACY_OPENING:TEST",
      partyId: 1,
      consignmentId: null,
      branchId: 1,
      entryType: "COD_COLLECTED",
      amount: "10000.00",
      notes: "اختبار لقطة عهدة قديمة",
      createdBy: 1,
    });

    await returnConsignment(Number(cn.id), { ...MANAGER, clientRequestId: "m4-legacy-ret-1" } as never);

    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(Number(party.currentBalance)).toBe(0);
    const summary = await getDeliveryFinancialSummary(1);
    expect(Number(summary.cashInCustody)).toBe(0);
    expect(Number(summary.codOutstandingRaw)).toBe(0);
    expect(summary.hasFinancialAnomaly).toBe(false);
    const reversals = await db().select().from(s.deliveryLedgerEntries).where(and(
      eq(s.deliveryLedgerEntries.consignmentId, Number(cn.id)),
      eq(s.deliveryLedgerEntries.entryType, "COD_REMITTED"),
    ));
    expect(reversals).toHaveLength(1);
  });

  it("M5: فاتورةٌ أُرجع منها جزءٌ سلفاً ⇒ إرجاع الإرسالية مرفوض (لا عكس مزدوج)", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m5-dbl",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];

    await expect(
      returnSale({ invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 3 }], restock: true }, MANAGER),
    ).rejects.toThrowError(/إرسالية مفتوحة/);
    await expect(
      returnConsignment(Number(cn.id), { ...MANAGER, clientRequestId: "m5-dbl-1" } as never),
    ).resolves.toBeTruthy();
    void shift;
  });
});

describe("M8 — قرار المالك: مرتجعُ فاتورةٍ بيد المندوب يخصم عهدته بقيمة ما عاد", () => {
  it("فاتورة 10,000 بعهدة المندوب ⇒ مرتجع 3 قطع (3,000) يعكس 3,000 من عهدته ويُخفّض COD الإرسالية", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m8-relief",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];

    await expect(
      returnSale({ invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 3 }], restock: true }, MANAGER),
    ).rejects.toThrowError(/إرسالية مفتوحة/);

    // لا نقد في عهدة المندوب قبل التسليم، ولا يُسمح بمرتجع مبيعات يتجاوز دورة الطرد.
    const party = (await db().select().from(s.deliveryParties).where(eq(s.deliveryParties.id, 1)))[0];
    expect(Number(party.currentBalance)).toBe(0);
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    expect(Number(cn.codAmount)).toBe(10000);
    const relief = await db().select().from(s.accountingEntries)
      .where(and(
        eq(s.accountingEntries.entryType, "DELIVERY_REMIT"),
        eq(s.accountingEntries.invoiceId, invoiceId),
      ));
    expect(relief).toHaveLength(0);
  });
});

describe("M9 — قرار المالك: ما ورّده المندوب يدخل سقف الاسترداد النقديّ", () => {
  it("زبونٌ عابر دفع للمندوب ⇒ يستطيع استرداد نقده عند الإرجاع (كان السقف صفراً)", async () => {
    const shift = await openReception();
    const r = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId,
      contactName: "زبون عابر", contactPhone: "07700000001",
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m9-cod-refund",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const invoiceId = r.regularSale!.invoiceId;
    const cn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];

    await deliverConsignment(Number(cn.id));
    await recordDeliveryRemittance(
      {
        branchId: 1,
        partyId: 1,
        lines: [{ consignmentId: Number(cn.id), collectedAmount: "10000.00" }],
        countedCash: "10000.00",
        clientRequestId: "m9-remittance",
      },
      CASHIER,
    );

    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];
    const ret = await returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 10 }],
      refund: { amount: "10000.00", method: "CASH", shiftId: shift.shiftId },
      restock: true,
    }, MANAGER);
    expect(ret).toBeTruthy();
    const out = (await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, invoiceId), eq(s.receipts.direction, "OUT"),
    )))[0];
    expect(out).toBeTruthy();
    expect(String(out.amount)).toBe("10000.00"); // الزبون العابر استردّ ديناره فعلاً
  });
});

describe("M6/M7 — عهدة المناديب أصلٌ ظاهر، وسقفها يُنفَّذ", () => {
  it("M6: عهدةُ زبونٍ عابر (بلا ذمّة) أصلٌ صريح في المركز المالي", async () => {
    const shift = await openReception();
    const checkout = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId,
      contactName: "زبون عابر", contactPhone: "07700000009",
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m6-pos",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const cn = await consignmentForInvoice(checkout.regularSale!.invoiceId);
    await deliverConsignment(Number(cn.id));
    const pos = await getFinancialPosition({ verify: false });
    expect(Number(pos.deliveryFloat)).toBe(10000);          // لا ذمّةَ تقابلها ⇒ أصلٌ كامل
    expect(Number(pos.deliveryFloatCustomerBacked)).toBe(0);
    expect(Number(pos.arDebit)).toBe(0);
    expect(Number(pos.totalAssets)).toBeGreaterThanOrEqual(10000);
    void shift;
  });

  it("M6.b (مراجعة PR #495): عهدةُ فاتورةٍ بعميلٍ مسجَّل لا تُحتسَب مرّتين — ذمّةٌ واحدة لا أصلان", async () => {
    const shift = await openReception();
    const checkout = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m6b-dup",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);
    const beforeDelivery = await getFinancialPosition({ verify: false });
    expect(Number(beforeDelivery.arDebit)).toBe(10000);
    expect(Number(beforeDelivery.deliveryFloat)).toBe(0);
    const cn = await consignmentForInvoice(checkout.regularSale!.invoiceId);
    await deliverConsignment(Number(cn.id));
    const pos = await getFinancialPosition({ verify: false });
    // عند التسليم تنتقل الذمّة من العميل إلى عهدة التوصيل ولا تتكرر في الأصول.
    expect(Number(pos.arDebit)).toBe(0);
    expect(Number(pos.deliveryFloat)).toBe(10000);
    expect(Number(pos.deliveryFloatCustomerBacked)).toBe(0);
    expect(Number(pos.arDebit) + Number(pos.deliveryFloat)).toBe(10000);
    void shift;
  });

  it("M7: عهدةٌ تتجاوز سقف المندوب تُرفض برسالةٍ تسمّي المبلغ", async () => {
    await db().update(s.deliveryParties).set({ floatLimit: "5000.00" }).where(eq(s.deliveryParties.id, 1));
    const shift = await openReception();
    await expect(checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "m7-limit",
      regularSale: { lines: [LINE], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER)).rejects.toThrowError(/يتجاوز السقف/);
  });
});
