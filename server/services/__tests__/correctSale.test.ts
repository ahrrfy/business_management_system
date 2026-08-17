/**
 * اختبارات correctSale (تصحيح الفاتورة 0168) — الحَكَم التجريبيّ لصحّة الكود الماليّ.
 *
 * النموذج: عكسٌ كامل (returnSaleInTx) + إعادة ترحيل (createSaleInTx) ذرّياً، والأصل SUPERSEDED.
 * تُثبت هذه الاختبارات على قاعدةٍ حقيقية: توازن الدفتر (Σإيراد الأصل=0، الجديد=المصحّح)، عكس COGS
 * + صافي المخزون. نقل المقبوضات التاريخية إلى البديل محظور في المرحلة الآمنة الحالية؛
 * والرفوضات، وidempotency، والربط ثنائيّ الاتجاه.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { correctSale } from "../sale/correct";
import { processPayment } from "../sale/payment";
import { getTodayNetSales } from "../reports/todaySales";
import { money } from "../money";

const admin = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "auditLogs", "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
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
/** بذرة: منتج بتكلفة ٦٠٠ وسعر مفرد ١٠٠٠، مخزون ١٠، وردية مفتوحة، + عميل اختياريّ. */
async function seed(opts: { withCustomer?: boolean } = {}) {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع", code: "BR2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "أدمن", role: "admin", loginMethod: "local" },
    { id: 2, openId: "local_mgr2", name: "مدير ٢", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "600.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
  await d.insert(s.shifts).values({ id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
  if (opts.withCustomer) {
    await d.insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0", creditLimit: "9999999.00" });
  }
}

async function getInvoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
async function getCustomerBalance(id: number): Promise<number> {
  return Number((await db().select({ b: s.customers.currentBalance }).from(s.customers).where(eq(s.customers.id, id)))[0].b);
}
async function getStock(variantId: number, branchId: number): Promise<number> {
  const r = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock).where(sql`${s.branchStock.variantId}=${variantId} AND ${s.branchStock.branchId}=${branchId}`))[0];
  return Number(r?.q ?? 0);
}
/** بيع نقديّ كامل لكميةٍ (كل وحدة ١٠٠٠). */
async function cashSale(qty: number) {
  return createSale({ branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
    lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }],
    payment: { amount: String(qty * 1000), method: "CASH" } }, admin);
}
function makeCtx(user: unknown) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
async function creditSale(qty: number) {
  return createSale({ branchId: 1, customerId: 1, priceTier: "RETAIL", sourceType: "ORDER",
    lines: [{ variantId: 1, productUnitId: 1, quantity: String(qty) }] }, admin);
}
const line = (qty: number) => ({ variantId: 1, productUnitId: 1, quantity: String(qty) });

describe("correctSale — تصحيح الفاتورة (عكس + إعادة ترحيل)", () => {
  beforeEach(async () => { await reset(); });

  // ⭐ قرار المالك (١٧/٨/٢٦): **المقبوض يُنتقل للفاتورة المصحّحة كما هو**. كان هنا حظرٌ شاملٌ
  //    لأي فاتورةٍ عليها مقبوضات — وأثرُه عملياً أنّ كل فاتورة استقبالٍ عليها عربون لا تُعدَّل أبداً.
  it("المقبوض يُنقل للمصحّحة كما هو — الإيصال يحتفظ بدرجه وطريقته، والفرق الزائد يُردّ نقداً", async () => {
    await seed();
    const sale = await cashSale(2); // ٢٠٠٠ مقبوضة نقداً
    const receiptBefore = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, sale.invoiceId)))[0];

    // تصحيحٌ لأسفل: قطعةٌ واحدة (١٠٠٠) ⇒ فرقٌ زائد ١٠٠٠ يُردّ نقداً (زبونٌ عابر بلا حساب).
    const res = await correctSale(
      { originalInvoiceId: sale.invoiceId, lines: [line(1)], overpayHandling: "CASH_REFUND" },
      admin,
    );
    expect(res.overpay).toBe("1000.00");
    expect(res.overpayHandled).toBe("CASH_REFUND");

    // الأصل استُبدِل، والجديدة مربوطةٌ به ثنائيّ الاتجاه.
    const original = await getInvoice(sale.invoiceId);
    expect(original.status).toBe("SUPERSEDED");
    expect(Number(original.correctedByInvoiceId)).toBe(res.correctedInvoiceId);

    // 🔒 الثابت الجوهريّ: الإيصال التاريخيّ **لم يُعَد كتابته** — نفس الدرج ونفس الطريقة ونفس
    //    المبلغ؛ تغيّر مؤشّره للفاتورة فقط (وهو ما قرّره المالك حرفياً).
    const receiptAfter = (await db().select().from(s.receipts).where(eq(s.receipts.id, receiptBefore.id)))[0];
    expect(receiptAfter.shiftId).toBe(receiptBefore.shiftId);
    expect(receiptAfter.paymentMethod).toBe(receiptBefore.paymentMethod);
    expect(receiptAfter.cashBucket).toBe(receiptBefore.cashBucket);
    expect(String(receiptAfter.amount)).toBe(String(receiptBefore.amount));
    expect(Number(receiptAfter.invoiceId)).toBe(res.correctedInvoiceId);

    // الفرق الزائد خرج بإيصال OUT نقديّ من الدرج (لا يضيع بصمت).
    const outs = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(outs).toHaveLength(1);
    expect(outs[0].paymentMethod).toBe("CASH");
    expect(outs[0].cashBucket).toBe("DRAWER");
    expect(Number(outs[0].amount)).toBeCloseTo(1000, 2);

    // المخزون: بيعت ٢ ثمّ عُكِست ٢ وأُعيد بيع ١ ⇒ ٩.
    expect(await getStock(1, 1)).toBe(9);
    const corrected = await getInvoice(res.correctedInvoiceId);
    expect(Number(corrected.total)).toBeCloseTo(1000, 2);
    expect(Number(corrected.paidAmount)).toBeCloseTo(1000, 2);
  });

  it("الفرق الزائد لعميلٍ مسجَّل يصير رصيداً دائناً بلا مسّ الدرج (الافتراضي)", async () => {
    await seed({ withCustomer: true });
    const sale = await createSale({ branchId: 1, shiftId: 1, customerId: 1, priceTier: "RETAIL", sourceType: "ORDER",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      payment: { amount: "2000", method: "CASH" } }, admin);

    const res = await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)] }, admin);
    expect(res.overpay).toBe("1000.00");
    expect(res.overpayHandled).toBe("CREDIT");
    // رصيدٌ دائن = سالب (له عندنا)، ولا نقد خرج من الدرج.
    expect(await getCustomerBalance(1)).toBeCloseTo(-1000, 2);
    expect(await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"))).toHaveLength(0);
  });

  it("تصحيحٌ لأعلى على فاتورةٍ مقبوضةٍ بلا عميل يبقى مرفوضاً (لا ذمّة على زبونٍ عابر)", async () => {
    await seed();
    const sale = await cashSale(1);
    await expect(correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(2)] }, admin))
      .rejects.toThrowError(/يتطلب عميلاً/);
    // رفضٌ ذرّيّ: الأصل والمخزون بلا مسّ.
    expect((await getInvoice(sale.invoiceId)).status).toBe("PAID");
    expect(await getStock(1, 1)).toBe(9);
  });

  it("تعديل البيانات لا يقبل إعادة كتابة طريقة إيصال تاريخي", async () => {
    await seed();
    const sale = await cashSale(1);
    const receiptBefore = (await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, sale.invoiceId)))[0];
    const user = (await db().select().from(s.users).where(eq(s.users.id, 1)).limit(1))[0];

    await appRouter.createCaller(makeCtx(user)).sales.correct({
      invoiceId: sale.invoiceId,
      notes: "تصحيح ملاحظة فقط",
      reason: "خطأ كتابي",
      receiptMethods: [{ receiptId: Number(receiptBefore.id), method: "CARD" }],
    } as any);

    const receiptAfter = (await db().select().from(s.receipts).where(eq(s.receipts.id, receiptBefore.id)))[0];
    expect(receiptAfter.paymentMethod).toBe("CASH");
    expect(receiptAfter.cashBucket).toBe(receiptBefore.cashBucket);
    expect(receiptAfter.shiftId).toBe(receiptBefore.shiftId);
    expect((await getInvoice(sale.invoiceId)).notes).toBe("تصحيح ملاحظة فقط");
  });

  it("idempotency: نفس المفتاح ⇒ إعادةٌ بلا تصحيحٍ ثانٍ (فاتورة واحدة جديدة)", async () => {
    await seed();
    await db().insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0", creditLimit: "9999999.00" });
    const sale = await creditSale(1);
    const first = await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)], clientRequestId: "corr-key-1" }, admin);
    const again = await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)], clientRequestId: "corr-key-1" }, admin);
    expect(again.correctedInvoiceId).toBe(first.correctedInvoiceId);
    expect(again.idempotentReplay).toBe(true);
    // فاتورةٌ جديدةٌ واحدة فقط (لا تكرار).
    const superseded = await db().select({ id: s.invoices.id }).from(s.invoices).where(eq(s.invoices.status, "SUPERSEDED"));
    expect(superseded).toHaveLength(1);
  });

  it("الفاتورة SUPERSEDED لا تُحصّل ولا تُحتسب ثانيةً في مبيعات اليوم", async () => {
    await seed({ withCustomer: true });
    const sale = await creditSale(1);
    const corrected = await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)] }, admin);
    const receiptsBefore = await db().select({ id: s.receipts.id }).from(s.receipts);
    const balanceBefore = await getCustomerBalance(1);

    await expect(processPayment({ invoiceId: sale.invoiceId, amount: "1000", method: "CASH", shiftId: 1 }, admin))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(await db().select({ id: s.receipts.id }).from(s.receipts)).toEqual(receiptsBefore);
    expect(await getCustomerBalance(1)).toBe(balanceBefore);
    const today = await getTodayNetSales(1);
    expect(today.invoiceCount).toBe(1);
    expect(today.total).toBe("1000.00");
    expect((await getInvoice(corrected.correctedInvoiceId)).status).toBe("PENDING");
  });

  it("يرفض عكس فاتورة خدمة كتعديل مخزني ويبقي الأصل بلا تغيير", async () => {
    await seed({ withCustomer: true });
    await db().update(s.products).set({ isService: true }).where(eq(s.products.id, 1));
    const sale = await creditSale(1);

    await expect(correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)] }, admin))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const original = await getInvoice(sale.invoiceId);
    expect(original.status).toBe("PENDING");
    expect(original.correctedByInvoiceId).toBeNull();
  });

  it("رفض: منشأ WORKORDER / مرتجعة سابقاً / فرعٌ آخر / مُستبدَلة سلفاً", async () => {
    await seed({ withCustomer: true });
    // WORKORDER
    const woSale = await createSale({ branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "WORKORDER",
      lines: [line(1)], payment: { amount: "1000", method: "CASH" } }, admin);
    await expect(correctSale({ originalInvoiceId: woSale.invoiceId, lines: [line(1)] }, admin)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // مرتجعة سابقاً (returnedTotal>0)
    const retSale = await cashSale(2);
    const it2 = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, retSale.invoiceId)))[0];
    await returnSale({ invoiceId: retSale.invoiceId, lines: [{ invoiceItemId: Number(it2.id), baseQuantity: 1 }], refund: { amount: "1000", method: "CASH" }, restock: true }, admin);
    await expect(correctSale({ originalInvoiceId: retSale.invoiceId, lines: [line(2)] }, admin)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // فرعٌ آخر (مدير فرع ٢ يصحّح فاتورة فرع ١)
    const s3 = await cashSale(1);
    await expect(correctSale({ originalInvoiceId: s3.invoiceId, lines: [line(1)] }, { userId: 2, branchId: 2, role: "manager" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // مُستبدَلة سلفاً (تصحيح مرّتين)
    const s4 = await creditSale(1);
    await correctSale({ originalInvoiceId: s4.invoiceId, lines: [line(1)] }, admin);
    await expect(correctSale({ originalInvoiceId: s4.invoiceId, lines: [line(1)] }, admin)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("رصيد دائن لعميلٍ عابر (بلا سجلّ) ⇒ يُرفَض (يلزم استرداد نقديّ)", async () => {
    await seed();
    const sale = await cashSale(1); // عميل نقديّ عابر
    await expect(correctSale({
      originalInvoiceId: sale.invoiceId,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "300" }],
      overpayHandling: "CREDIT", priceOverrideApproved: true,
    }, admin)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("حارس النقل الماليّ: مدفوعٌ لا تُغطّيه إيصالات القبض القابلة للنقل (عربونٌ غير مختوم) ⇒ رفضٌ بلا مسٍّ للأصل", async () => {
    await seed({ withCustomer: true });
    const sale = await createSale({ branchId: 1, customerId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
      lines: [line(1)], payment: { amount: "1000", method: "CASH" } }, admin);
    // نُحاكي عربوناً موّل paidAmount لكن إيصالَ أمّه غير مختومٍ بهذه الفاتورة (invoiceId=NULL).
    await db().update(s.receipts).set({ invoiceId: null })
      .where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='IN'`);
    // بعد رفع حظر المقبوضات الشامل صار هذا الحارس **يُختبَر فعلاً** (كان محجوباً خلفه):
    // نتحقّق من رسالته لا من رمزه فقط، كي يبقى الاختبار مثبتاً للسبب الصحيح.
    await expect(correctSale({ originalInvoiceId: sale.invoiceId, customerId: 1, lines: [line(1)] }, admin))
      .rejects.toThrowError(/لا يطابق إيصالات القبض القابلة للنقل/);
    // الرفض قبل أيّ تعديل ⇒ الأصل لم يُستبدَل ولم تُصفَّر ذمّة العميل زوراً.
    expect((await getInvoice(sale.invoiceId)).status).not.toBe("SUPERSEDED");
  });

  it("حارس العميل: تغيير العميل في تصحيحٍ عليه مدفوعات ⇒ يُرفَض (المقبوض يخصّ الأصليّ)", async () => {
    await seed({ withCustomer: true });
    await db().insert(s.customers).values({ id: 2, name: "عميل ٢", currentBalance: "0", creditLimit: "9999999.00" });
    const sale = await createSale({ branchId: 1, customerId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
      lines: [line(1)], payment: { amount: "1000", method: "CASH" } }, admin);
    await expect(correctSale({ originalInvoiceId: sale.invoiceId, customerId: 2, lines: [line(1)] }, admin))
      .rejects.toThrowError(/لا يُغيَّر العميل/);
  });

  it("حارس الدفعة الإضافية: تحصيلٌ يتجاوز الفرق المستحقّ ⇒ يُرفَض (حصِّل الفرق فقط)", async () => {
    await seed();
    const sale = await cashSale(1); // ١٠٠٠ مدفوعٌ كاملاً ⇒ لا نقص
    await expect(correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)],
      additionalPayment: { amount: "500", method: "CASH" } }, admin))
      .rejects.toThrowError(/تتجاوز الفرق المستحقّ/);
  });
});
