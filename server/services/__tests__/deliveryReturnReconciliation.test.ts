/**
 * اختبارات تسوية إرساليات التوصيل التلقائية عند المرتجع (R1 & R2).
 *
 * يتحقق هذا الجناح من:
 * 1. السماح بإرجاع الفاتورة بالكامل وهي في حالة OUT_FOR_DELIVERY دون أخطاء تحقق (تحقيق R1).
 * 2. التسوية التلقائية للإرسالية لتصبح RETURNED وCANCELLED مع تحرير الـ COD (تحقيق R2).
 * 3. إنشاء قيد COD_RELEASED وتصفير تعرّض المندوب codOutstanding.
 * 4. نجاح المرتجع لفاتورة مسلّمة (DELIVERED) ومالها UNSETTLED، وتسوية حالتها المالية إلى SETTLED.
 * 5. المرتجع الجزئي على إرسالية نشطة يحرر الـ COD بنسبة ما أُرجع دون كسر مسار الطرد.
 * 6. استمرار عمل المرتجعات العادية على الفواتير التي ليس عليها توصيل بكفاءة وتطابق كامل.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { transitionConsignmentParcel, confirmConsignmentDelivery } from "../delivery/courier";
import { getDeliveryFinancialSummary } from "../delivery/lifecycle";
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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "cr", name: "مندوب", email: "d@t.test", role: "courier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر تجارب" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "EXP-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
  await d.insert(s.deliveryParties).values([{
    id: 1, name: "شركة التوصيل السريع", partyType: "INDIVIDUAL", defaultFee: "0.00",
    currentBalance: "0.00", userId: 3,
  }]);
}

async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

const LINE_10 = { variantId: 1, productUnitId: 1, quantity: "10" }; // 10 * 1,000 = 10,000 IQD

async function advanceToOutForDelivery(consignmentId: number) {
  for (const toStatus of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const) {
    await transitionConsignmentParcel(
      { consignmentId, toStatus, clientRequestId: `test-${consignmentId}-${toStatus}` },
      { userId: 3 },
    );
  }
}

async function advanceToDelivered(consignmentId: number) {
  await advanceToOutForDelivery(consignmentId);
  await confirmConsignmentDelivery(
    { consignmentId, clientRequestId: `test-${consignmentId}-delivered` },
    { userId: 3 },
  );
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("تسوية إرساليات التوصيل التلقائية عند المرتجع (R1 & R2)", () => {
  it("R1 + R2: إرجاع كامل لفاتورة في حالة OUT_FOR_DELIVERY ينجح ويسوي الإرسالية تلقائياً", async () => {
    const shift = await openReception();
    const sale = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "r1-full-out",
      regularSale: { lines: [LINE_10], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);

    const invoiceId = sale.regularSale!.invoiceId;
    const initialCn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    await advanceToOutForDelivery(Number(initialCn.id));

    // التحقق من حالة الطرد قبل المرتجع
    const cnBefore = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, initialCn.id)))[0];
    expect(cnBefore.parcelStatus).toBe("OUT_FOR_DELIVERY");
    expect(cnBefore.moneyStatus).toBe("UNSETTLED");
    expect(cnBefore.status).toBe("DISPATCHED");

    // التحقق من تعرّض الـ COD الأولي
    const summaryBefore = await getDeliveryFinancialSummary(1);
    expect(Number(summaryBefore.codAssigned)).toBe(10000);
    expect(Number(summaryBefore.codOutstanding)).toBe(10000);

    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];

    // R1: تنفيذ المرتجع الكامل — كان يفشل بـ PRECONDITION_FAILED
    const ret = await returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 10 }],
      restock: true,
    }, MANAGER);

    expect(ret.fullyReturned).toBe(true);
    expect(ret.returnedTotal).toBe("10000.00");

    // R2: التحقق من الحالة المغلقة للإرسالية
    const cnAfter = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, initialCn.id)))[0];
    expect(cnAfter.parcelStatus).toBe("RETURNED");
    expect(cnAfter.status).toBe("RETURNED");
    expect(cnAfter.moneyStatus).toBe("CANCELLED");
    expect(cnAfter.returnedAt).not.toBeNull();
    expect(cnAfter.settledAt).not.toBeNull();
    expect(Number(cnAfter.counterSettledAmount)).toBe(10000);

    // التحقق من قيد تحرير التعرّض وتصفير تعرّض المندوب
    const ledger = await db().select().from(s.deliveryLedgerEntries).where(and(
      eq(s.deliveryLedgerEntries.consignmentId, initialCn.id),
      eq(s.deliveryLedgerEntries.entryType, "COD_RELEASED"),
    ));
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(10000);

    const summaryAfter = await getDeliveryFinancialSummary(1);
    expect(Number(summaryAfter.codReleased)).toBe(10000);
    expect(Number(summaryAfter.codOutstanding)).toBe(0);

    // التحقق من حدث دورة الحياة
    const events = await db().select().from(s.deliveryEvents).where(and(
      eq(s.deliveryEvents.consignmentId, initialCn.id),
      eq(s.deliveryEvents.eventType, "RETURN_SETTLEMENT"),
    ));
    expect(events).toHaveLength(1);
    expect(events[0].toParcelStatus).toBe("RETURNED");
    expect(events[0].toMoneyStatus).toBe("CANCELLED");

    // التحقق من إعادة المخزون مرة واحدة فقط دون ازدواج
    const stock = (await db().select().from(s.branchStock).where(and(
      eq(s.branchStock.branchId, 1),
      eq(s.branchStock.variantId, 1),
    )))[0];
    expect(stock.quantity).toBe(100);
  });

  it("R2: إرجاع لفاتورة مسلّمة (DELIVERED) بنقد معلق (UNSETTLED) يعكس العهدة ويُحوّل الإرسالية إلى RETURNED و CANCELLED", async () => {
    const shift = await openReception();
    const sale = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "r2-delivered-unsettled",
      regularSale: { lines: [LINE_10], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);

    const invoiceId = sale.regularSale!.invoiceId;
    const initialCn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    await advanceToDelivered(Number(initialCn.id));

    const cnBefore = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, initialCn.id)))[0];
    expect(cnBefore.parcelStatus).toBe("DELIVERED");
    expect(cnBefore.moneyStatus).toBe("UNSETTLED");

    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];

    // إرجاع الفاتورة المسلّمة بعد ثبوت التسليم
    const ret = await returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 10 }],
      restock: true,
    }, MANAGER);

    expect(ret.fullyReturned).toBe(true);

    const cnAfter = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, initialCn.id)))[0];
    expect(cnAfter.parcelStatus).toBe("RETURNED");
    expect(cnAfter.status).toBe("RETURNED");
    expect(cnAfter.moneyStatus).toBe("CANCELLED");
    expect(cnAfter.returnedAt).not.toBeNull();

    const summaryAfter = await getDeliveryFinancialSummary(1);
    expect(Number(summaryAfter.codOutstanding)).toBe(0);
  });

  it("المرتجع الجزئي على إرسالية نشطة يحرر الـ COD بنسبة ما أُرجع مع بقاء باقي الطرد حياً", async () => {
    const shift = await openReception();
    const sale = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "r2-partial-active",
      regularSale: { lines: [LINE_10], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);

    const invoiceId = sale.regularSale!.invoiceId;
    const initialCn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    await advanceToOutForDelivery(Number(initialCn.id));

    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];

    // إرجاع 4 قطع من أصل 10 (4,000 د.ع)
    const ret1 = await returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 4 }],
      restock: true,
    }, MANAGER);

    expect(ret1.fullyReturned).toBe(false);
    expect(ret1.returnedTotal).toBe("4000.00");

    const cn1 = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, initialCn.id)))[0];
    expect(cn1.parcelStatus).toBe("OUT_FOR_DELIVERY");
    expect(cn1.status).toBe("DISPATCHED");
    expect(Number(cn1.counterSettledAmount)).toBe(4000);

    const summary1 = await getDeliveryFinancialSummary(1);
    expect(Number(summary1.codReleased)).toBe(4000);
    expect(Number(summary1.codOutstanding)).toBe(6000);

    // إرجاع الـ 6 قطع المتبقية (6,000 د.ع) ليكتمل الإرجاع
    const ret2 = await returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 6 }],
      restock: true,
    }, MANAGER);

    expect(ret2.fullyReturned).toBe(true);

    const cn2 = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, initialCn.id)))[0];
    expect(cn2.parcelStatus).toBe("RETURNED");
    expect(cn2.status).toBe("RETURNED");
    expect(cn2.moneyStatus).toBe("CANCELLED");
    expect(Number(cn2.counterSettledAmount)).toBe(10000);

    const summary2 = await getDeliveryFinancialSummary(1);
    expect(Number(summary2.codReleased)).toBe(10000);
    expect(Number(summary2.codOutstanding)).toBe(0);
  });

  it("المرتجع العادي لفاتورة بدون توصيل يستمر بالعمل دون أي تأثر أو انحدار", async () => {
    const shift = await openReception();
    const sale = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "10000.00",
      clientRequestId: "normal-return-no-deliv",
      regularSale: { lines: [LINE_10], amount: "10000.00" },
    }, CASHIER);

    const invoiceId = sale.regularSale!.invoiceId;
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];

    const ret = await returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 10 }],
      restock: true,
    }, MANAGER);

    expect(ret.fullyReturned).toBe(true);
    expect(ret.returnedTotal).toBe("10000.00");

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, invoiceId)))[0];
    expect(inv.status).toBe("RETURNED");

    // التأكد من عدم وجود أي قيود توصيل
    const cns = await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId));
    expect(cns).toHaveLength(0);
  });

  it("إرجاع طرد جرى تحصيل جزء من نقده سلفاً يحرر الباقي ويُبقي المحصّل عهدة للتوريد", async () => {
    const shift = await openReception();
    const sale = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "0",
      clientRequestId: "r2-collected-part",
      regularSale: { lines: [LINE_10], amount: "10000.00" },
      delivery: { partyId: 1, fee: "0", feeCollection: "COURIER" },
    }, CASHIER);

    const invoiceId = sale.regularSale!.invoiceId;
    const initialCn = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, invoiceId)))[0];
    await advanceToOutForDelivery(Number(initialCn.id));

    // محاكاة تحصيل المندوب 3,000 د.ع نقداً من الزبون قبل الإرجاع
    await db().update(s.deliveryConsignments).set({
      collectedAmount: "3000.00",
    }).where(eq(s.deliveryConsignments.id, initialCn.id));

    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId)))[0];

    // إرجاع الفاتورة
    const ret = await returnSale({
      invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 10 }],
      restock: true,
    }, MANAGER);

    expect(ret.fullyReturned).toBe(true);

    const cnAfter = (await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, initialCn.id)))[0];
    expect(cnAfter.parcelStatus).toBe("RETURNED");
    expect(cnAfter.status).toBe("RETURNED");
    // بما أنه تم تحصيل 3,000 سابقاً، فإن حالة المال تصبح SETTLED لحساب المتبقي
    expect(cnAfter.moneyStatus).toBe("SETTLED");
    // المتبقي غير المحصل كان 7,000 وحُرّر
    expect(Number(cnAfter.counterSettledAmount)).toBe(7000);

    const ledger = await db().select().from(s.deliveryLedgerEntries).where(and(
      eq(s.deliveryLedgerEntries.consignmentId, initialCn.id),
      eq(s.deliveryLedgerEntries.entryType, "COD_RELEASED"),
    ));
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(7000);
  });
});
