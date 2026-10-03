/**
 * التصحيح الكامل لفاتورة مقبوضة (قرار المالك ٣/١٠/٢٦) — تسوية مقبوضات الأصل.
 *
 * الحالة الحقيقية: فاتورة 22873 صدرت نقداً لزبون عابر خطأً، والصحيح آجلاً على حساب الأب. كان
 * التصحيح مرفوضاً كلّياً («الفاتورة تحمل مقبوضات مرتبطة بعميلها الأصلي…»). هذه الاختبارات تثبت
 * على قاعدةٍ حقيقية أنّ التصحيح الآن ذرّيّ ولا يمحو تاريخاً:
 *   · النقد غير المستلَم يخرج من «متوقَّع» وردية الأصل (مفتوحة: تلقائياً؛ مغلقة بعجز: تسوية موثّقة).
 *   · نقل مقبوضٍ مستلَم فعلاً لعميلٍ آخر صافي أثره على الدرج صفر، وكشف كل طرف صحيح.
 *   · المالك ينفّذ فوراً؛ غيره يطلب ومراجعٌ مستقلّ يعتمد؛ الفشل يتراجع كاملاً.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { correctSale } from "../sale/correct";
import {
  approveSalesControlRequest,
  requestSalesControl,
  withdrawSalesControlRequest,
} from "../sale/controlRequests";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
import { getCustomerStatement } from "../reports/arAging";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";
import { withTx } from "../tx";
import { money } from "../money";
import {
  confirmExternalPaymentAttempt,
  initiateExternalPaymentAttempt,
} from "../posExternalPayment";

const TABLES = [
  "salesExchangeCommands", "salesControlRequests", "returnRequests", "digitalSaleDetails",
  "installmentPlans", "deliveryConsignments", "onlineOrders", "cashDailyReconciliations",
  "externalPaymentAttempts", "auditLogs", "idempotencyKeys", "accountingEntries", "receipts",
  "inventoryMovements", "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const ADMIN = { userId: 1, branchId: 1, role: "admin" as const };
const CASHIER = { userId: 2, branchId: 1, role: "cashier" };
const MANAGER = { userId: 3, branchId: 1, role: "manager" };
const OWNER = { userId: 4, branchId: 1, role: "admin" };
const SON = 1;
const FATHER = 2;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  const d = db();
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "rs-admin", name: "أدمن", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rs-cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "rs-manager", name: "مدير مستقل", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "rs-owner", name: "المالك", role: "admin", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
  ]);
  await d.insert(s.customers).values([
    { id: SON, name: "الابن", currentBalance: "0", creditLimit: "99999999.00" },
    { id: FATHER, name: "الأب", currentBalance: "0", creditLimit: "99999999.00" },
  ]);
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-RS", costPrice: "600.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.shifts).values([
    { id: 1, userId: 2, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "2:1:RETAIL", openingBalance: "0" },
    { id: 2, userId: 3, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "3:1:RETAIL", openingBalance: "50000" },
  ]);
});

const line = (qty: number) => ({ variantId: 1, productUnitId: 1, quantity: String(qty) });

async function walkInCashSale(qty: number) {
  return createSale({
    branchId: 1, shiftId: 1, sourceType: "POS", priceTier: "RETAIL",
    lines: [line(qty)],
    payment: { amount: String(qty * 1000), method: "CASH" },
  }, CASHIER);
}
async function customerCashSale(customerId: number, qty: number) {
  return createSale({
    branchId: 1, shiftId: 1, sourceType: "POS", priceTier: "RETAIL", customerId,
    lines: [line(qty)],
    payment: { amount: String(qty * 1000), method: "CASH" },
  }, CASHIER);
}
async function drawer(shiftId: number) {
  const sh = (await db().select().from(s.shifts).where(eq(s.shifts.id, shiftId)))[0];
  return withTx((tx) => computeDrawerCashBalance(tx, shiftId, sh.openingBalance ?? "0"));
}
async function balance(customerId: number) {
  return Number((await db().select().from(s.customers).where(eq(s.customers.id, customerId)))[0].currentBalance);
}
async function invoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
async function receiptsOf(invoiceId: number) {
  return db().select().from(s.receipts).where(eq(s.receipts.invoiceId, invoiceId));
}
/** يغلق الوردية كما يغلقها مسارٌ تاريخيّ بعجز (المعدود أقلّ من المتوقَّع بالمبلغ المفقود). */
async function closeShiftWithShortage(shiftId: number, shortage: number) {
  const expected = await drawer(shiftId);
  const counted = expected.minus(shortage);
  await db().update(s.shifts).set({
    status: "CLOSED",
    openGuard: null,
    closedAt: new Date(),
    expectedCash: expected.toFixed(2),
    countedCash: counted.toFixed(2),
    variance: counted.minus(expected).toFixed(2),
    reconciliationStatus: shortage === 0 ? "MATCHED" : "EXPLAINED",
    varianceReasonCode: shortage === 0 ? null : "OTHER",
    varianceReason: shortage === 0 ? null : "عجز غير مفسّر",
  }).where(eq(s.shifts.id, shiftId));
}
/** صافي الكشف: فواتير غير ملغاة − دفعات IN + دفعات OUT — يجب أن يساوي الرصيد الجاري. */
async function statementNet(customerId: number) {
  const st = await getCustomerStatement(customerId);
  if (!st) throw new Error("no statement");
  let net = money(0);
  for (const inv of st.invoices) if (inv.status !== "CANCELLED") net = net.plus(inv.total);
  for (const p of st.payments) net = p.direction === "IN" ? net.minus(p.amount) : net.plus(p.amount);
  return { net: Number(net.toFixed(2)), current: Number(st.summary.currentBalance) };
}

describe("التصحيح الكامل — تسوية مقبوضات الأصل", () => {
  it("١) عابر نقدي ← آجل على الأب، الوردية مفتوحة: النقد غير المستلَم يخرج من الدرج والأب يُدان", async () => {
    const sale = await walkInCashSale(3);
    expect((await drawer(1)).toFixed(2)).toBe("3000.00");

    const corrected = await correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(3)],
      priorPaymentReceivedAmount: "0",
      clientRequestId: "rs-1",
    }, ADMIN);

    expect(corrected.settlement?.notReceivedAmount).toBe("3000.00");
    expect(corrected.settlement?.carriedAmount).toBe("0.00");
    expect((await drawer(1)).toFixed(2)).toBe("0.00");
    expect(await balance(FATHER)).toBeCloseTo(3000, 2);
    const replacement = await invoice(corrected.correctedInvoiceId);
    expect(Number(replacement.customerId)).toBe(FATHER);
    expect(Number(replacement.paidAmount)).toBe(0);
    expect(replacement.paymentMethod).toBeNull();
    // لا محو: الأصل REVERSED وله إيصال تعويضي OUT على الوردية نفسها.
    const original = await receiptsOf(sale.invoiceId);
    expect(original.find((r) => r.direction === "IN")?.status).toBe("REVERSED");
    const out = original.find((r) => r.direction === "OUT");
    expect(out?.status).toBe("COMPLETED");
    expect(Number(out?.shiftId)).toBe(1);
    expect(out?.referenceNumber).toMatch(/^CORR-REV-/);
    expect((await invoice(sale.invoiceId)).status).toBe("SUPERSEDED");
    const st = await statementNet(FATHER);
    expect(st.net).toBeCloseTo(st.current, 2);
    expect(st.current).toBeCloseTo(3000, 2);
  });

  it("٢) الوردية مغلقة بعجزٍ يساوي المبلغ: تسوية موثّقة تجعلها MATCHED بلا إعادة فتح", async () => {
    const sale = await walkInCashSale(2);
    await closeShiftWithShortage(1, 2000);
    const before = (await db().select().from(s.shifts).where(eq(s.shifts.id, 1)))[0];
    expect(before.variance).toBe("-2000.00");

    const corrected = await correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(2)],
      priorPaymentReceivedAmount: "0",
    }, ADMIN);

    const after = (await db().select().from(s.shifts).where(eq(s.shifts.id, 1)))[0];
    expect(after.status).toBe("CLOSED");
    expect(after.countedCash).toBe(before.countedCash);
    expect(after.expectedCash).toBe(money(before.expectedCash!).minus(2000).toFixed(2));
    expect(after.variance).toBe("0.00");
    expect(after.reconciliationStatus).toBe("MATCHED");
    expect(after.varianceReason).toBeNull();
    expect(corrected.settlement?.shiftEffects).toEqual([
      expect.objectContaining({ shiftId: 1, status: "CLOSED", cashDelta: "-2000.00", varianceAfter: "0.00" }),
    ]);
    const audit = await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "shift.postCloseCorrectionAdjustment"));
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe("1");
    expect(await balance(FATHER)).toBeCloseTo(2000, 2);
  });

  it("٢ب) الوردية مغلقة مطابقة (العدّ أثبت وجود النقد): يُرفض «لم يُستلم» ولا يتغيّر شيء", async () => {
    const sale = await walkInCashSale(2);
    await closeShiftWithShortage(1, 0);
    const entriesBefore = (await db().select().from(s.accountingEntries)).length;
    await expect(correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(2)],
      priorPaymentReceivedAmount: "0",
    }, ADMIN)).rejects.toThrow(/العدّ أثبت أنّ المال استُلم/);
    expect((await invoice(sale.invoiceId)).status).toBe("PAID");
    expect((await receiptsOf(sale.invoiceId)).every((r) => r.status === "COMPLETED")).toBe(true);
    expect((await db().select().from(s.accountingEntries)).length).toBe(entriesBefore);
    expect(await balance(FATHER)).toBe(0);
    const sh = (await db().select().from(s.shifts).where(eq(s.shifts.id, 1)))[0];
    expect(sh.reconciliationStatus).toBe("MATCHED");
  });

  it("٢ج) يوم الوردية المغلقة مُقفلة مطابقة خزينته: يُرفض بلا أثر", async () => {
    const sale = await walkInCashSale(1);
    await closeShiftWithShortage(1, 1000);
    const sh = (await db().select().from(s.shifts).where(eq(s.shifts.id, 1)))[0];
    await db().insert(s.cashDailyReconciliations).values({
      branchId: 1,
      businessDate: new Date(sh.openedAt).toISOString().slice(0, 10),
      expectedTreasuryCash: "0", countedTreasuryCash: "0", variance: "0",
      status: "CLOSED", lastClientRequestId: "rs-day-1", evidenceHash: "x".repeat(64),
      countedByUserId: 1,
    });
    await expect(correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(1)],
      priorPaymentReceivedAmount: "0",
    }, ADMIN)).rejects.toThrow(/مُقفلة مطابقة خزينته/);
    expect((await invoice(sale.invoiceId)).status).toBe("PAID");
  });

  it("٣) نقدي ← بطاقة: النقد غير المستلَم يُعكس والبطاقة تُقبض بإثبات جهاز", async () => {
    const sale = await customerCashSale(SON, 1);
    const deviceId = "RS-CARD-DEVICE";
    const attempt = await initiateExternalPaymentAttempt({
      branchId: 1, channel: "SALES_COLLECTION", method: "CARD", amount: "1000.00",
      reference: "RS-CARD-1", requestId: "rs-card-attempt-1", deviceId,
    }, ADMIN);
    await confirmExternalPaymentAttempt({ attemptId: attempt.attemptId, branchId: 1, channel: "SALES_COLLECTION", deviceId }, ADMIN);

    const corrected = await correctSale({
      originalInvoiceId: sale.invoiceId,
      lines: [line(1)],
      priorPaymentReceivedAmount: "0",
      additionalPayment: {
        amount: "1000.00", method: "CARD", reference: "RS-CARD-1",
        externalPaymentAttemptId: attempt.attemptId, externalPaymentDeviceId: deviceId,
      },
    }, ADMIN);

    expect((await drawer(1)).toFixed(2)).toBe("0.00");
    const replacement = await invoice(corrected.correctedInvoiceId);
    expect(replacement.paymentMethod).toBe("CARD");
    expect(Number(replacement.paidAmount)).toBeCloseTo(1000, 2);
    expect(await balance(SON)).toBeCloseTo(0, 2);
    const st = await statementNet(SON);
    expect(st.net).toBeCloseTo(st.current, 2);
  });

  it("٤) نقل مقبوضٍ مستلَم فعلاً من الابن للأب: صافي الدرج صفر وكشف الطرفين صحيح", async () => {
    const sale = await customerCashSale(SON, 2);
    const drawerBefore = await drawer(1);

    const corrected = await correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(2)],
      priorPaymentReceivedAmount: "2000.00",
    }, ADMIN);

    expect(corrected.settlement?.carriedAmount).toBe("2000.00");
    expect(corrected.settlement?.notReceivedAmount).toBe("0.00");
    expect((await drawer(1)).toFixed(2)).toBe(drawerBefore.toFixed(2));
    expect(await balance(SON)).toBeCloseTo(0, 2);
    expect(await balance(FATHER)).toBeCloseTo(0, 2);
    const replacement = await invoice(corrected.correctedInvoiceId);
    expect(replacement.status).toBe("PAID");
    expect(Number(replacement.paidAmount)).toBeCloseTo(2000, 2);
    const carried = (await receiptsOf(corrected.correctedInvoiceId)).filter((r) => r.direction === "IN");
    expect(carried).toHaveLength(1);
    expect(carried[0].partyType).toBe("CUSTOMER");
    expect(Number(carried[0].partyId)).toBe(FATHER);
    expect(Number(carried[0].shiftId)).toBe(1);
    const payIn = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.receiptId, carried[0].id), eq(s.accountingEntries.entryType, "PAYMENT_IN")));
    expect(Number(payIn[0].customerId)).toBe(FATHER);
    for (const c of [SON, FATHER]) {
      const st = await statementNet(c);
      expect(st.net).toBeCloseTo(st.current, 2);
    }
  });

  it("٥) البنود + العميل + الدفع معاً: عابر ٢ نقداً ← الأب ٣، لم يُستلم شيء، وفرق نقدي الآن على درج مفتوح", async () => {
    const sale = await walkInCashSale(2);
    const otherBefore = await drawer(2);
    const corrected = await correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(3)],
      priorPaymentReceivedAmount: "0",
      additionalPayment: { amount: "1000.00", method: "CASH", shiftId: 2 },
      // الفرق النقدي يقبضه صاحب الدرج المفتوح نفسه (SHIFT-OWN: لا قبض على وردية موظف آخر).
    }, MANAGER);
    expect((await drawer(1)).toFixed(2)).toBe("0.00");
    expect((await drawer(2)).minus(otherBefore).toFixed(2)).toBe("1000.00");
    expect(await balance(FATHER)).toBeCloseTo(2000, 2);
    const replacement = await invoice(corrected.correctedInvoiceId);
    expect(Number(replacement.total)).toBeCloseTo(3000, 2);
    expect(Number(replacement.paidAmount)).toBeCloseTo(1000, 2);
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(Number(stock.quantity)).toBe(97);
  });

  it("٦) مختلط: استُلم جزءٌ فقط والباقي آجل على الأب", async () => {
    const sale = await walkInCashSale(3);
    const corrected = await correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(3)],
      priorPaymentReceivedAmount: "1000",
    }, ADMIN);
    expect((await drawer(1)).toFixed(2)).toBe("1000.00");
    expect(await balance(FATHER)).toBeCloseTo(2000, 2);
    const replacement = await invoice(corrected.correctedInvoiceId);
    expect(Number(replacement.paidAmount)).toBeCloseTo(1000, 2);
    expect(replacement.status).toBe("PARTIALLY_PAID");
    const st = await statementNet(FATHER);
    expect(st.net).toBeCloseTo(st.current, 2);
  });

  it("٦ب) المستلَم المُعلَن أكبر من المسجَّل يُرفض", async () => {
    const sale = await walkInCashSale(1);
    await expect(correctSale({
      originalInvoiceId: sale.invoiceId,
      customerId: FATHER,
      lines: [line(1)],
      priorPaymentReceivedAmount: "5000",
    }, ADMIN)).rejects.toThrow(/خارج المقبوض المسجَّل/);
  });

  it("٧) غير المالك يطلب فقط، ومنشئ الفاتورة لا يعتمد، والمراجع المستقل ينفّذ؛ المالك ينفّذ فوراً", async () => {
    // منشئ الفاتورة (المدير هنا) لا يعتمد تصحيحها — فاتورةٌ مستقلّة كي لا تُفسد لقطة الطلب الأساسيّ.
    const createdByManager = await walkInCashSale(1);
    await db().update(s.invoices).set({ createdBy: 3 }).where(eq(s.invoices.id, createdByManager.invoiceId));
    const blocked = await requestSalesControl({
      requestKey: "rs-req-creator",
      invoiceId: createdByManager.invoiceId,
      requestType: "SALES_REISSUE",
      reason: "طلب على فاتورة أنشأها المراجع",
      payload: { customerId: FATHER, lines: [line(1)], priorPaymentReceivedAmount: "0" },
    }, CASHIER);
    await expect(approveSalesControlRequest(Number(blocked.id), MANAGER)).rejects.toThrow(/منشئ الفاتورة/);
    expect((await invoice(createdByManager.invoiceId)).status).toBe("PAID");
    await withdrawSalesControlRequest(Number(blocked.id), "سحب بعد رفض منشئ الفاتورة", CASHIER);

    const sale = await walkInCashSale(1);
    const requested = await requestSalesControl({
      requestKey: "rs-req-1",
      invoiceId: sale.invoiceId,
      requestType: "SALES_REISSUE",
      reason: "بيع آجل على حساب الأب صدر نقداً خطأً",
      payload: { customerId: FATHER, lines: [line(1)], priorPaymentReceivedAmount: "0" },
    }, CASHIER);
    expect(requested.status).toBe("PENDING");
    expect((await invoice(sale.invoiceId)).status).toBe("PAID");
    await expect(approveSalesControlRequest(Number(requested.id), CASHIER)).rejects.toThrow();
    const approved = await approveSalesControlRequest(Number(requested.id), MANAGER);
    expect("request" in approved && approved.request.status).toBe("APPROVED");
    expect(await balance(FATHER)).toBeCloseTo(1000, 2);

    const second = await walkInCashSale(2);
    const ownerRun = await requestSalesControl({
      requestKey: "rs-owner-1",
      invoiceId: second.invoiceId,
      requestType: "SALES_REISSUE",
      reason: "تصحيح المالك المباشر",
      payload: { customerId: FATHER, lines: [line(2)], priorPaymentReceivedAmount: "0" },
    }, OWNER);
    expect(ownerRun.status).toBe("APPROVED");
    expect("resultInvoiceId" in ownerRun && ownerRun.resultInvoiceId).toBeTruthy();
    expect((await invoice(second.invoiceId)).status).toBe("SUPERSEDED");
    expect(await balance(FATHER)).toBeCloseTo(3000, 2);
  });

  it("٨) فشل المالك يتراجع كاملاً ويسحب طلبه؛ وإعادة اعتماد طلبٍ منفَّذ replay بلا أثر ثانٍ", async () => {
    const sale = await walkInCashSale(1);
    await closeShiftWithShortage(1, 0);
    await expect(requestSalesControl({
      requestKey: "rs-owner-fail",
      invoiceId: sale.invoiceId,
      requestType: "SALES_REISSUE",
      reason: "محاولة إخراج نقد عدّته وردية مطابقة",
      payload: { customerId: FATHER, lines: [line(1)], priorPaymentReceivedAmount: "0" },
    }, OWNER)).rejects.toThrow(/العدّ أثبت/);
    const req = (await db().select().from(s.salesControlRequests))[0];
    expect(req.status).toBe("WITHDRAWN");
    expect((await invoice(sale.invoiceId)).status).toBe("PAID");
    expect(await balance(FATHER)).toBe(0);

    // بلا إعلان المستلَم فعلاً يبقى نقل المقبوض لعميلٍ آخر مرفوضاً (لا يُستنتَج من الصمت).
    await expect(requestSalesControl({
      requestKey: "rs-owner-undeclared",
      invoiceId: sale.invoiceId,
      requestType: "SALES_REISSUE",
      reason: "نقل بلا إعلان المستلَم",
      payload: { customerId: FATHER, lines: [line(1)] },
    }, OWNER)).rejects.toThrow(/لا يُغيَّر العميل/);
    expect((await invoice(sale.invoiceId)).status).toBe("PAID");

    // نفس الفاتورة ممكن تعديلها لاحقاً كمستلَم فعلاً (نقل للأب بلا أثر درج).
    const ok = await requestSalesControl({
      requestKey: "rs-owner-ok",
      invoiceId: sale.invoiceId,
      requestType: "SALES_REISSUE",
      reason: "المال استُلم فعلاً؛ نقله للأب",
      payload: { customerId: FATHER, lines: [line(1)], priorPaymentReceivedAmount: "1000.00" },
    }, OWNER);
    expect(ok.status).toBe("APPROVED");
    const entries = (await db().select().from(s.accountingEntries)).length;
    const replay = await approveSalesControlRequest(Number(ok.id), MANAGER);
    expect(replay.replayed).toBe(true);
    expect((await db().select().from(s.accountingEntries)).length).toBe(entries);
    const sh = (await db().select().from(s.shifts).where(eq(s.shifts.id, 1)))[0];
    expect(sh.variance).toBe("0.00");
    expect(sh.reconciliationStatus).toBe("MATCHED");
  });

  it("٩) العميل نفسه وكل المسجَّل مستلَم: المسار القديم (نقل حرفيّ للإيصال) بلا إيصالات تعويضية", async () => {
    const sale = await customerCashSale(SON, 1);
    const receiptId = (await receiptsOf(sale.invoiceId))[0].id;
    const corrected = await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)] }, ADMIN);
    expect(corrected.settlement).toBeUndefined();
    const moved = (await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId)))[0];
    expect(Number(moved.invoiceId)).toBe(corrected.correctedInvoiceId);
    expect(moved.status).toBe("COMPLETED");
    expect((await db().select().from(s.receipts)).length).toBe(1);
  });
});
