/**
 * إلغاء فاتورة بيع (قرار مالك ١٢/٨/٢٦) — «الفاتورة كأنّها لم تكن»:
 *   ثابت ١ (صافي الدفتر): Σ(revenue) = Σ(cost) = Σ(profit) = ٠ على invoiceId ⇐ عكسٌ كاملٌ للقيد.
 *   ثابت ٢ (إرجاع مخزون): كل بند رصيده يعود لما كان قبل البيع (RETURN بكمّية remainingBase الفعليّة).
 *   ثابت ٣ (استرداد بجهة صرف): PAYMENT_OUT بمبلغ paidAmount + receipt.direction=OUT بطريقةٍ مُصرَّحة.
 *   ثابت ٤ (حراس): خارج الفترة/لغير المدير على فرع آخر/فاتورة ملغاة أو مرتجعة/كروت رقمية/أمر شغل ⇒ رفض.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelSale } from "../sale/cancel";
import { correctSale } from "../sale/correct";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { processPayment } from "../sale/payment";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";
import { lockPeriod } from "../periodLockService";
import { money } from "../money";

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const manager = { userId: 2, branchId: 1, role: "manager" as const };
const managerOtherBranch = { userId: 3, branchId: 2, role: "manager" as const };

const TABLES = [
  "idempotencyKeys",
  "financialPeriods",
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryRemittanceLines",
  "deliveryLedgerEntries",
  "deliveryConsignments",
  "deliveryRemittances",
  "deliveryParties",
  "onlineOrderItems",
  "onlineOrders",
  "installmentLines",
  "installmentPlans",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "branches",
  "users",
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

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "mgr", name: "manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "mgr2", name: "manager2", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "400.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
  // وردية مفتوحة للمدير على الفرع ١ (يسمح باسترداد نقديّ من DRAWER أو TREASURY حسب الحالة).
  await d.insert(s.shifts).values({
    id: 1,
    userId: 2,
    branchId: 1,
    status: "OPEN",
    openedAt: new Date(),
    openGuard: "2:1",
    openingBalance: "0",
  });
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

async function stockOf(variantId: number, branchId: number): Promise<number> {
  const row = (
    await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(sql`${s.branchStock.variantId}=${variantId} AND ${s.branchStock.branchId}=${branchId}`)
      .limit(1)
  )[0];
  return Number(row?.q ?? 0);
}

async function sumCol(invoiceId: number, col: "revenue" | "cost" | "profit" | "amount"): Promise<number> {
  const rows = await db()
    .select({ v: s.accountingEntries[col] })
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.invoiceId, invoiceId));
  return rows.reduce((t, r) => t + Number(r.v), 0);
}

async function customerBalance(customerId: number): Promise<string> {
  const row = (
    await db().select({ b: s.customers.currentBalance }).from(s.customers).where(eq(s.customers.id, customerId)).limit(1)
  )[0];
  return String(row?.b ?? "0");
}

async function seedDeliveryParty(id = 1, branchId = 1) {
  await db().insert(s.deliveryParties).values({
    id,
    name: `مندوب ${id}`,
    branchId,
    partyType: "INDIVIDUAL",
  });
}

async function dispatchInvoice(invoiceId: number, suffix: string) {
  return dispatchInvoiceToDelivery(
    {
      invoiceId,
      partyId: 1,
      deliveryFee: "0",
      feeCollection: "COURIER",
      clientRequestId: `dispatch-cancel-guard-${suffix}`,
    },
    admin,
  );
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("cancelSale — ثابت ١ + ٢: صافي الدفتر صفر + رصيد المخزون يعود كاملاً", () => {
  it("بيعٌ آجل (٥ قطع) ⇒ إلغاء ⇒ Σ(revenue)=Σ(cost)=Σ(profit)=٠ ورصيد المخزون يعود ١٠", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      },
      admin,
    );
    // بيع ٥ قطع × ١٠٠٠ = ٥٠٠٠ إيراد، ٥ × ٤٠٠ = ٢٠٠٠ تكلفة، ربح ٣٠٠٠.
    expect(await stockOf(1, 1)).toBe(5);
    expect(money(await sumCol(sale.invoiceId, "revenue")).toFixed(2)).toBe("5000.00");
    expect(money(await sumCol(sale.invoiceId, "profit")).toFixed(2)).toBe("3000.00");

    const res = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "خطأ إدخال" },
      admin,
    );
    expect(res.refundAmount).toBe("0.00"); // لم يُدفع شيء (آجل)
    expect(res.refundVoucherNumber).toBeNull();

    // صافي الدفتر صفر (الثابت الحاكم).
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "cost")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "profit")).isZero()).toBe(true);

    // المخزون يعود كاملاً.
    expect(await stockOf(1, 1)).toBe(10);

    // الفاتورة CANCELLED + لقطة تدقيق.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).toBe("CANCELLED");
    expect(inv.cancelledBy).toBe(1);
    expect(inv.cancelledByNameSnapshot).toBe("admin");
    expect(inv.cancelledAt).toBeTruthy();

    // ذمّة العميل تعود لصفر (كانت +٥٠٠٠ ثم أُسقطت).
    expect(money(await customerBalance(1)).toFixed(2)).toBe("0.00");
  });
});

describe("cancelSale — ثابت ٣: استرداد بجهة صرف نقديّ + PAYMENT_OUT", () => {
  it("دفعة CASH وإلغاء الفاتورة على الدرج نفسه يتسلسلان بلا deadlock", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );

    const results = await Promise.allSettled([
      processPayment(
        { invoiceId: sale.invoiceId, amount: "1000.00", method: "CASH", shiftId: 1, clientRequestId: "pay-cancel-race" },
        manager,
      ),
      cancelSale(
        { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "سباق دفع وإلغاء", clientRequestId: "cancel-pay-race" },
        manager,
      ),
    ]);

    const failures = results.flatMap((result) => result.status === "rejected"
      ? [String(result.reason?.message ?? result.reason)]
      : []);
    expect(failures).not.toEqual(expect.arrayContaining([expect.stringMatching(/DEADLOCK|ER_LOCK_DEADLOCK/i)]));
    expect(failures.every((message) => /ملغاة|نهائية|مدفوعة|لا يمكن الدفع/.test(message))).toBe(true);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).toBe("CANCELLED");
    const cash = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, sale.invoiceId));
    const net = cash.reduce((sum, receipt) =>
      sum + (receipt.direction === "IN" ? Number(receipt.amount) : -Number(receipt.amount)), 0);
    expect(net).toBe(0);
  });

  it("بيعٌ نقديّ كامل (مندوب) ⇒ إلغاء (مدير آخر) ⇒ إيصال صرفٍ OUT بمبلغ paidAmount + PAYMENT_OUT + المخزون يعود", async () => {
    await setStock(1, 1, 10);
    // بيع نقديّ كامل: paidNow = 5000. البائع = admin. الملغي = manager (SOD مُحترمة).
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        shiftId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        payment: { amount: "5000.00", method: "CASH" },
      },
      { userId: 2, branchId: 1, role: "manager" as const }, // manager as seller (owns shift 1)
    );
    const invBefore = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(invBefore.paidAmount).toBe("5000.00");

    // الملغي = admin (مختلف عن البائع manager) ⇒ SOD مُحترمة.
    const res = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "طلب زبون" },
      admin,
    );
    expect(res.refundAmount).toBe("5000.00");
    // Codex P1 #1 (١٢/٨): لا voucherNumber على إيصال الاسترداد (يبقى ضمن returnsCash لا expensesCash).
    expect(res.refundVoucherNumber).toBeNull();

    // receipts.direction=OUT بالمبلغ الصحيح + طريقة الدفع + بلا voucherNumber.
    const outs = await db()
      .select()
      .from(s.receipts)
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='OUT'`);
    expect(outs).toHaveLength(1);
    expect(outs[0].amount).toBe("5000.00");
    expect(outs[0].paymentMethod).toBe("CASH");
    // admin بلا وردية مفتوحة ⇒ TREASURY (لا DRAWER لأن admin ليس مالك shift 1).
    expect(outs[0].cashBucket).toBe("TREASURY");
    expect(outs[0].voucherNumber).toBeNull();
    expect(outs[0].partyType).toBe("CUSTOMER");

    // قيد PAYMENT_OUT مرتبط بالفاتورة.
    const payOut = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(sql`${s.accountingEntries.invoiceId}=${sale.invoiceId} AND ${s.accountingEntries.entryType}='PAYMENT_OUT'`)
    )[0];
    expect(payOut).toBeTruthy();
    expect(payOut!.amount).toBe("5000.00");

    // المخزون يعود كاملاً + الفاتورة CANCELLED + paidAmount صار صفراً.
    expect(await stockOf(1, 1)).toBe(10);
    const invAfter = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(invAfter.status).toBe("CANCELLED");
    expect(invAfter.paidAmount).toBe("0.00");
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "cost")).isZero()).toBe(true);
  });

  it("نقص خزينة المستردّ ⇒ rollback كامل ولا تُلغى الفاتورة أو يعود المخزون", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        shiftId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { amount: "2000.00", method: "CASH" },
      },
      manager,
    );
    await db()
      .delete(s.receipts)
      .where(eq(s.receipts.referenceNumber, "TEST-TREASURY-FUND"));

    await expect(
      cancelSale(
        { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" },
        admin,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const invoice = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId))
    )[0];
    expect(invoice.status).toBe("PAID");
    expect(await stockOf(1, 1)).toBe(8);
    const refunds = await db()
      .select()
      .from(s.receipts)
      .where(
        sql`${s.receipts.invoiceId} = ${sale.invoiceId} AND ${s.receipts.direction} = 'OUT'`,
      );
    expect(refunds).toHaveLength(0);
    const cancelEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        sql`${s.accountingEntries.invoiceId} = ${sale.invoiceId} AND ${s.accountingEntries.entryType} IN ('RETURN', 'PAYMENT_OUT')`,
      );
    expect(cancelEntries).toHaveLength(0);
  });

  it("إلغاء بطريقة استرداد غير النقد (TRANSFER) ⇒ receipt بلا cashBucket + المبلغ صحيح", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      },
      admin,
    );
    // دفعة تحويل جزئيّة على الفاتورة (٢٠٠٠ من أصل ٢٠٠٠).
    const invRow = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    await db().update(s.invoices).set({ paidAmount: "2000.00", status: "PAID" }).where(eq(s.invoices.id, sale.invoiceId));
    await db().insert(s.receipts).values({
      invoiceId: sale.invoiceId,
      branchId: 1,
      direction: "IN",
      amount: "2000.00",
      paymentMethod: "TRANSFER",
      status: "COMPLETED",
      createdBy: 1,
    });

    const res = await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin);
    expect(res.refundAmount).toBe("0.00");
    expect(res.pendingRefundAmount).toBe("2000.00");

    const outs = await db()
      .select()
      .from(s.receipts)
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='OUT'`);
    expect(outs).toHaveLength(1);
    expect(outs[0].paymentMethod).toBe("TRANSFER");
    expect(outs[0].cashBucket).toBeNull(); // TRANSFER لا يمسّ صندوقاً
    // الاسترداد غير النقدي طلبُ صرف معلّقٌ مُرقّم حتى يعتمد مالك مستقل.
    expect(outs[0].voucherNumber).toMatch(/^PV-/);

    // صافي الدفتر صفر.
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "cost")).isZero()).toBe(true);
    void invRow;
  });
});

describe("cancelSale — البطاقة رافدُ ردٍّ فوريّ (قرار المالك ١٧/٨/٢٦، مطابقٌ لـreturnService)", () => {
  it("زبونٌ عابر (بلا عميل) مدفوعٌ بالبطاقة + مرجع جهاز صحيح ⇒ فوريّ، بلا اشتراط عميل", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { amount: "2000.00", method: "CASH" },
      },
      manager, // زبونٌ عابر — بلا customerId
    );
    // إعادة وسم إيصال القبض بطاقةً — يحاكي فاتورة بطاقةٍ بلا فتح مسار قبضٍ خارجيّ حيّ (نمط returnRefundRails.test.ts).
    await db()
      .update(s.receipts)
      .set({ paymentMethod: "CARD", cashBucket: null, referenceNumber: "CARD-IN-1" })
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='IN'`);

    const res = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CARD", reference: "TERM-REFUND-501" },
      admin,
    );
    expect(res.refundAmount).toBe("2000.00");
    expect(res.pendingRefundAmount).toBe("0.00");

    const outs = await db()
      .select()
      .from(s.receipts)
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='OUT'`);
    expect(outs).toHaveLength(1);
    expect(outs[0]!.status).toBe("COMPLETED");
    expect(outs[0]!.approvalStatus).toBe("APPROVED");
    expect(outs[0]!.cashBucket).toBeNull();
    expect(outs[0]!.voucherNumber).toBeNull(); // لم يدخل طابور السندات المعلَّقة
    expect(outs[0]!.referenceNumber).toBe("TERM-REFUND-501");

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).toBe("CANCELLED");
    expect(Number(inv.paidAmount)).toBeCloseTo(0, 2);

    // قيدُ PAYMENT_OUT فوريّ — لا الاكتفاء بـpendingRefundAmount كما كان قبل الإصلاح.
    const payOuts = await db()
      .select()
      .from(s.accountingEntries)
      .where(sql`${s.accountingEntries.invoiceId}=${sale.invoiceId} AND ${s.accountingEntries.entryType}='PAYMENT_OUT'`);
    expect(payOuts).toHaveLength(1);
    expect(Number(payOuts[0]!.amount)).toBeCloseTo(2000, 2);
  });

  it("البطاقة بلا مرجع جهاز ⇒ يُرفض قبل أي أثر", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        shiftId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { amount: "2000.00", method: "CASH" },
      },
      manager,
    );
    await db()
      .update(s.receipts)
      .set({ paymentMethod: "CARD", cashBucket: null, referenceNumber: "CARD-IN-1" })
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='IN'`);

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CARD" }, admin),
    ).rejects.toThrow(/مرجع عملية الاسترداد/);

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).not.toBe("CANCELLED");
    expect(await stockOf(1, 1)).toBe(8); // لم يُعَد — رفضٌ صفري الأثر
    const outs = await db()
      .select()
      .from(s.receipts)
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='OUT'`);
    expect(outs).toHaveLength(0);
  });
});

describe("cancelSale — ثابت ٤: الحراس (رفض خارج الفترة/عبر الفرع/فاتورة ملغاة أو مرتجعة)", () => {
  it("خارج الفترة المفتوحة (assertPeriodOpen) ⇒ FORBIDDEN من postEntry، لا كتابات جانبية", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    // اقفل الفترة على تاريخ اليوم — أي قيد جديد اليوم (تاريخ RETURN الافتراضي) يُرفض.
    await db().transaction(async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      await lockPeriod(tx as any, { cutoffDate: today, lockedBy: 1 });
    });

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);

    // الفاتورة لم تتغيّر (لا CANCELLED) + المخزون لم يعُد.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.status).not.toBe("CANCELLED");
    expect(await stockOf(1, 1)).toBe(9); // لم يُعَد.
  });

  it("مدير فرع آخر ⇒ FORBIDDEN «الفاتورة لا تخصّ فرعك»", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, managerOtherBranch),
    ).rejects.toThrow(/لا تخصّ فرعك/);
  });

  it("فاتورة CANCELLED مسبقاً ⇒ رفض «ملغاة مسبقاً» (idempotency بلا مفتاح)", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin);
    // محاولة إلغاء ثانية بلا clientRequestId ⇒ رفض صريح.
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/ملغاة مسبقاً/);
  });

  it("فاتورة RETURNED بالكامل ⇒ رفض «لا حاجة للإلغاء»", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        refund: null,
        restock: true,
      },
      admin,
    );
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/مُرتجَعة بالكامل/);
  });

  it("فاتورة WORKORDER ⇒ رفض «استعمل مسار إلغاء أمر الشغل»", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "WORKORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/إلغاء أمر الشغل/);
  });

  it("idempotency: نفس clientRequestId ⇒ replay بلا أثر ثانٍ", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const key = "cancel-key-" + Date.now();
    const r1 = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", clientRequestId: key },
      admin,
    );
    expect(r1.idempotentReplay).toBeFalsy();
    const stockAfter1 = await stockOf(1, 1);
    const revAfter1 = await sumCol(sale.invoiceId, "revenue");

    // Replay بنفس المفتاح: لا يعيد الإرجاع ولا يعكس شيئاً — يُعيد وسم idempotentReplay.
    const r2 = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", clientRequestId: key },
      admin,
    );
    expect(r2.idempotentReplay).toBe(true);
    expect(await stockOf(1, 1)).toBe(stockAfter1);
    expect(await sumCol(sale.invoiceId, "revenue")).toBe(revAfter1);
  });
});

describe("cancelSale — إصلاحات مراجعة Codex (١٢/٨)", () => {
  it("P1: SOD — مدير أنشأ البيع لا يستطيع إلغاءه بنفسه (admin يعبُر)", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      manager, // createdBy = 2
    );
    // نفس المدير يحاول الإلغاء ⇒ رفض SOD.
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, manager),
    ).rejects.toThrow(/فصل المهام|أصدرتها بنفسك/);
    // admin يعبُر (السلطة النهائية).
    const res = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" },
      admin,
    );
    expect(res.invoiceId).toBe(sale.invoiceId);
  });

  it("P1: فاتورة في شهرٍ مُقفَل تُرفَض حتى لو الإلغاء بيومٍ مفتوح", async () => {
    await setStock(1, 1, 10);
    // أنشئ فاتورة وأضبط تاريخها لأمس عمداً.
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db().update(s.invoices).set({ invoiceDate: yesterday }).where(eq(s.invoices.id, sale.invoiceId));
    // أقفل الفترة على تاريخ أمس (يوم إصدار الفاتورة داخل الفترة المُقفَلة).
    const cutoff = yesterday.toISOString().slice(0, 10);
    await db().transaction(async (tx) => {
      await lockPeriod(tx as any, { cutoffDate: cutoff, lockedBy: 1 });
    });
    // الإلغاء بيوم لاحق مفتوح ⇒ رفض (لأنّ تاريخ الفاتورة داخل المُقفَل).
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/الفترة المالية مُقفَلة/);
  });

  it("P1: خطة أقساط ACTIVE تمنع الإلغاء", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await db().insert(s.installmentPlans).values({
      customerId: 1,
      invoiceId: sale.invoiceId,
      branchId: 1,
      totalAmount: "1000.00",
      status: "ACTIVE",
      createdBy: 1,
    });
    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin),
    ).rejects.toThrow(/خطة أقساط|ألغِ الخطة أولاً/);
  });

  it("P1: مقبوضاتُ سندٍ خارجيّ مرتبطة بالفاتورة تدخل مبلغ الاسترداد (لا تترك ائتماناً وهميّاً)", async () => {
    await setStock(1, 1, 10);
    // بيع آجل: paidAmount=0
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
      },
      admin,
    );
    // محاكاة سند قبض خارجيّ مرتبط بالفاتورة (لا يرفع inv.paidAmount — نمط voucher/create.ts).
    // ٥٠٠ TRANSFER من العميل.
    await db().insert(s.receipts).values({
      invoiceId: sale.invoiceId,
      branchId: 1,
      direction: "IN",
      amount: "500.00",
      paymentMethod: "TRANSFER",
      status: "COMPLETED",
      partyType: "CUSTOMER",
      partyId: 1,
      createdBy: 1,
    });
    // خفض ذمة العميل يدوياً (voucher/create يفعلها) — العميل بلا حدّ ائتماني (المستهلك للفاتورة كاملها ٣٠٠٠).
    await db().update(s.customers).set({ currentBalance: "2500.00" }).where(eq(s.customers.id, 1));

    // الإلغاء ⇒ يجب أن يشمل الاسترداد ٥٠٠ (المدفوع عبر السند) لا صفراً.
    const res = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" },
      admin,
    );
    expect(res.refundAmount).toBe("0.00");
    expect(res.pendingRefundAmount).toBe("500.00");
    // يبقى الائتمان الحقيقي ظاهراً حتى اعتماد طلب الاسترداد غير النقدي.
    expect(money(await customerBalance(1)).toFixed(2)).toBe("-500.00");
  });

  it("P2: مرتجع تالفٍ سابق ⇒ الإلغاء يزيد returnedRestockedBaseQuantity بالمتبقّي فقط لا بكل الكميّة", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      },
      admin,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    // مرتجع جزئي بـrestock=false (تالف) لوحدتين ⇒ returnedRestockedBaseQuantity يبقى صفراً.
    await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }],
        refund: null,
        restock: false,
      },
      admin,
    );
    const midItem = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, Number(item.id))))[0];
    expect(midItem.returnedBaseQuantity).toBe(2);
    expect(midItem.returnedRestockedBaseQuantity).toBe(0);

    // إلغاء ⇒ المتبقّي (٣) يعود للمخزون. returnedRestockedBaseQuantity يزداد بـ٣ لا يقفز لـ٥.
    await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin);
    const finalItem = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, Number(item.id))))[0];
    expect(finalItem.returnedBaseQuantity).toBe(5); // كل البند مُرتجَع
    expect(finalItem.returnedRestockedBaseQuantity).toBe(3); // فقط الـ٣ التي عادت فعلاً
    // المخزون: 10 − 5 (بيع) + 3 (إلغاء) = 8 (الوحدتان التالفتان لم تعودا).
    expect(await stockOf(1, 1)).toBe(8);
  });

  it("P2: replay بعد استرداد فعليّ يعيد بناء refundAmount الحقيقيّ (لا صفراً وهمياً)", async () => {
    await setStock(1, 1, 10);
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        shiftId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { amount: "2000.00", method: "CASH" },
      },
      manager,
    );
    const key = "cancel-refund-" + Date.now();
    const r1 = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", clientRequestId: key },
      admin,
    );
    expect(r1.refundAmount).toBe("2000.00");
    // Replay ⇒ يعيد نفس refundAmount من الإيصال المخزَّن (لا 0.00 كما كان قبل الإصلاح).
    const r2 = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", clientRequestId: key },
      admin,
    );
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.refundAmount).toBe("2000.00");
  });
});

describe("cancelSale — حارس التوصيل الموحّد", () => {
  it("يرفض إلغاء فاتورة ذات إرسالية حيّة بلا أي أثر جانبي", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const dispatched = await dispatchInvoice(sale.invoiceId, "live");

    await expect(
      cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "TRANSFER",
          clientRequestId: "cancel-live-consignment",
        },
        admin,
      ),
    ).rejects.toThrow(/الإرسالية.*حيّة|ألغِ إسناد التوصيل أولاً/);

    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    const consignment = (
      await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, dispatched.consignmentId))
    )[0];
    expect(invoice.status).not.toBe("CANCELLED");
    expect(consignment.status).toBe("DISPATCHED");
    expect(consignment.parcelStatus).toBe("ASSIGNED");
    expect(consignment.moneyStatus).toBe("UNSETTLED");
    expect(await stockOf(1, 1)).toBe(9);
    const cancellationReturns = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.accountingEntries)
      .where(sql`${s.accountingEntries.invoiceId}=${sale.invoiceId} AND ${s.accountingEntries.entryType}='RETURN'`);
    expect(Number(cancellationReturns[0]?.n ?? 0)).toBe(0);
  });

  it("لا يستهلك مفتاح idempotency عند المنع، ثم يسمح بعد إلغاء الإسناد الآمن ويعيد replay", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const dispatched = await dispatchInvoice(sale.invoiceId, "idempotency");
    const key = "cancel-after-delivery-release";

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER", clientRequestId: key }, admin),
    ).rejects.toThrow(/الإرسالية.*حيّة|ألغِ إسناد التوصيل أولاً/);

    await cancelDeliveryAssignment(
      {
        consignmentId: dispatched.consignmentId,
        reason: "إلغاء الإسناد قبل إلغاء الفاتورة",
        clientRequestId: "release-before-sale-cancel",
      },
      admin,
    );

    const first = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER", clientRequestId: key },
      admin,
    );
    const stockAfterFirst = await stockOf(1, 1);
    const replay = await cancelSale(
      { invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER", clientRequestId: key },
      admin,
    );
    expect(first.idempotentReplay).toBeFalsy();
    expect(replay.idempotentReplay).toBe(true);
    expect(stockAfterFirst).toBe(10);
    expect(await stockOf(1, 1)).toBe(stockAfterFirst);
  });

  it("يرفض إرسالية موسومة CANCELLED إذا بقي عليها تحصيل أو تعرض مالي", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const dispatched = await dispatchInvoice(sale.invoiceId, "unsafe-cancelled");
    await db()
      .update(s.deliveryConsignments)
      .set({
        status: "CANCELLED",
        parcelStatus: "CANCELLED",
        moneyStatus: "CANCELLED",
        collectedAmount: "100.00",
      })
      .where(eq(s.deliveryConsignments.id, dispatched.consignmentId));

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin),
    ).rejects.toThrow(/أثر مالي|عهدة|تحصيل/);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).not.toBe("CANCELLED");
    expect(await stockOf(1, 1)).toBe(9);
  });

  it("سباق الإسناد مع الإلغاء لا ينتهي أبداً بفاتورة ملغاة وطرد حي", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );

    const results = await Promise.allSettled([
      cancelSale(
        {
          invoiceId: sale.invoiceId,
          refundPaymentMethod: "TRANSFER",
          clientRequestId: "race-sale-cancel",
        },
        admin,
      ),
      dispatchInvoice(sale.invoiceId, "race"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    const consignment = (
      await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, sale.invoiceId)).limit(1)
    )[0];
    const liveConsignment = consignment != null && (
      consignment.status !== "CANCELLED"
      || consignment.parcelStatus !== "CANCELLED"
      || consignment.moneyStatus !== "CANCELLED"
    );
    expect(invoice.status === "CANCELLED" && liveConsignment).toBe(false);
  });

  it("يعزل الفرع قبل كشف حالة الإرسالية ولا يغيّر الفاتورة أو الطرد", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const dispatched = await dispatchInvoice(sale.invoiceId, "branch");

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, managerOtherBranch),
    ).rejects.toThrow(/لا تخصّ فرعك/);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).not.toBe("CANCELLED");
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, dispatched.consignmentId)))[0].status).toBe("DISPATCHED");
    expect(await stockOf(1, 1)).toBe(9);
  });

  it("يمنع طلب متجر قديم SHIPPED، ويسمح فقط بـCANCELLED بلا دليل COD", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ONLINE",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await db().insert(s.onlineOrders).values({
      id: 1,
      orderNumber: "WEB-CANCEL-GUARD-1",
      customerId: 1,
      branchId: 1,
      invoiceId: sale.invoiceId,
      subtotal: "1000.00",
      total: "1000.00",
      status: "SHIPPED",
      deliveryPartyId: 1,
    });

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin),
    ).rejects.toThrow(/طلب المتجر.*قيد التوصيل|تعذّر التسليم/);
    expect(await stockOf(1, 1)).toBe(9);

    await db().update(s.onlineOrders).set({ status: "CANCELLED", cancelReason: "لم يخرج الطرد" }).where(eq(s.onlineOrders.id, 1));
    const result = await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin);
    expect(result.invoiceId).toBe(sale.invoiceId);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).toBe("CANCELLED");
    expect(await stockOf(1, 1)).toBe(10);
  });

  it("يرفض طلب متجر قديم CANCELLED إذا وُجد تحصيل COD سابق", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ONLINE",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await db().insert(s.onlineOrders).values({
      id: 2,
      orderNumber: "WEB-CANCEL-GUARD-2",
      customerId: 1,
      branchId: 1,
      invoiceId: sale.invoiceId,
      subtotal: "1000.00",
      total: "1000.00",
      status: "CANCELLED",
      cancelReason: "بيانات قديمة متناقضة",
      deliveryPartyId: 1,
    });
    await db().insert(s.deliveryLedgerEntries).values({
      eventKey: "ONLINE:2:COD_COLLECTED",
      partyId: 1,
      branchId: 1,
      entryType: "COD_COLLECTED",
      amount: "1000.00",
      createdBy: 1,
    });

    await expect(
      cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin),
    ).rejects.toThrow(/طلب المتجر.*COD|عهدة/);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).not.toBe("CANCELLED");
    expect(await stockOf(1, 1)).toBe(9);
  });

  it.each([
    {
      label: "DELIVERED + SETTLED",
      status: "DELIVERED" as const,
      parcelStatus: "DELIVERED" as const,
      moneyStatus: "SETTLED" as const,
    },
    {
      label: "WRITTEN_OFF",
      status: "WRITTEN_OFF" as const,
      parcelStatus: "DELIVERED" as const,
      moneyStatus: "WRITTEN_OFF" as const,
    },
  ])("correctSale يرفض إرسالية $label بلا أي عكس أو إعادة إصدار", async (deliveryState) => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const dispatched = await dispatchInvoice(sale.invoiceId, `correct-${deliveryState.status.toLowerCase()}`);
    await db()
      .update(s.deliveryConsignments)
      .set({
        status: deliveryState.status,
        parcelStatus: deliveryState.parcelStatus,
        moneyStatus: deliveryState.moneyStatus,
        collectedAmount: "1000.00",
        settledAt: new Date(),
      })
      .where(eq(s.deliveryConsignments.id, dispatched.consignmentId));
    const invoiceCountBefore = await db().select({ n: sql<number>`COUNT(*)` }).from(s.invoices);
    const idempotencyCountBefore = await db().select({ n: sql<number>`COUNT(*)` }).from(s.idempotencyKeys);

    await expect(
      correctSale(
        {
          originalInvoiceId: sale.invoiceId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          clientRequestId: `correct-blocked-${deliveryState.status.toLowerCase()}`,
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).toBe("PENDING");
    expect(await stockOf(1, 1)).toBe(9);
    expect(Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.invoices))[0]?.n ?? 0))
      .toBe(Number(invoiceCountBefore[0]?.n ?? 0));
    expect(Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.idempotencyKeys))[0]?.n ?? 0))
      .toBe(Number(idempotencyCountBefore[0]?.n ?? 0));
    const reversalEntries = await db()
      .select({ n: sql<number>`COUNT(*)` })
      .from(s.accountingEntries)
      .where(sql`${s.accountingEntries.invoiceId}=${sale.invoiceId} AND ${s.accountingEntries.entryType}='RETURN'`);
    expect(Number(reversalEntries[0]?.n ?? 0)).toBe(0);
  });

  it("correctSale يسمح فقط بعد وصول الإرسالية إلى الإلغاء الثلاثي الآمن", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    const dispatched = await dispatchInvoice(sale.invoiceId, "correct-safe-cancelled");
    await cancelDeliveryAssignment(
      {
        consignmentId: dispatched.consignmentId,
        reason: "إلغاء الإسناد قبل تصحيح الفاتورة",
        clientRequestId: "release-before-sale-correct",
      },
      admin,
    );

    const corrected = await correctSale(
      {
        originalInvoiceId: sale.invoiceId,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        clientRequestId: "correct-after-safe-cancel",
      },
      admin,
    );

    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).toBe("SUPERSEDED");
    expect((await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.id, dispatched.consignmentId)))[0])
      .toMatchObject({ status: "CANCELLED", parcelStatus: "CANCELLED", moneyStatus: "CANCELLED" });
    expect(corrected.correctedInvoiceId).toBeGreaterThan(sale.invoiceId);
    expect(await stockOf(1, 1)).toBe(9);
  });

  it("correctSale يرفض طلب متجر قديم SHIPPED بلا عكس أو استهلاك idempotency", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ONLINE",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );
    await db().insert(s.onlineOrders).values({
      orderNumber: "WEB-CORRECT-GUARD-1",
      customerId: 1,
      branchId: 1,
      invoiceId: sale.invoiceId,
      subtotal: "1000.00",
      total: "1000.00",
      status: "SHIPPED",
      deliveryPartyId: 1,
    });
    const idempotencyBefore = await db().select({ n: sql<number>`COUNT(*)` }).from(s.idempotencyKeys);

    await expect(
      correctSale(
        {
          originalInvoiceId: sale.invoiceId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          clientRequestId: "correct-legacy-shipped",
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).toBe("PENDING");
    expect(await stockOf(1, 1)).toBe(9);
    expect(Number((await db().select({ n: sql<number>`COUNT(*)` }).from(s.idempotencyKeys))[0]?.n ?? 0))
      .toBe(Number(idempotencyBefore[0]?.n ?? 0));
  });

  it("سباق الإسناد مع correctSale لا ينتهي أبداً بفاتورة مستبدلة وطرد حي", async () => {
    await setStock(1, 1, 10);
    await seedDeliveryParty();
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      },
      admin,
    );

    const results = await Promise.allSettled([
      correctSale(
        {
          originalInvoiceId: sale.invoiceId,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          clientRequestId: "race-sale-correct",
        },
        admin,
      ),
      dispatchInvoice(sale.invoiceId, "correct-race"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const invoice = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    const consignment = (
      await db().select().from(s.deliveryConsignments).where(eq(s.deliveryConsignments.invoiceId, sale.invoiceId)).limit(1)
    )[0];
    const liveConsignment = consignment != null && (
      consignment.status !== "CANCELLED"
      || consignment.parcelStatus !== "CANCELLED"
      || consignment.moneyStatus !== "CANCELLED"
    );
    expect(invoice.status === "SUPERSEDED" && liveConsignment).toBe(false);
  });
});
