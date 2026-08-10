/**
 * اختبارات correctSale (تصحيح الفاتورة 0168) — الحَكَم التجريبيّ لصحّة الكود الماليّ.
 *
 * النموذج: عكسٌ كامل (returnSaleInTx) + إعادة ترحيل (createSaleInTx) ذرّياً، والأصل SUPERSEDED.
 * تُثبت هذه الاختبارات على قاعدةٍ حقيقية: توازن الدفتر (Σإيراد الأصل=0، الجديد=المصحّح)، عكس COGS
 * + صافي المخزون، صحّة الذمّة عبر (عكس + تصحيح +المدفوع + ترحيل)، ومساري overpay (رصيد/نقد)،
 * والرفوضات، وidempotency، والربط ثنائيّ الاتجاه.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { correctSale } from "../sale/correct";
import { money } from "../money";

const admin = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
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

async function sumCol(invoiceId: number, col: "revenue" | "profit"): Promise<number> {
  const rows = await db().select({ v: s.accountingEntries[col] }).from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId, invoiceId));
  return rows.reduce((t, r) => t + Number(r.v), 0);
}
async function receiptSum(invoiceId: number, dir: "IN" | "OUT"): Promise<number> {
  const rows = await db().select({ v: s.receipts.amount }).from(s.receipts).where(sql`${s.receipts.invoiceId}=${invoiceId} AND ${s.receipts.direction}=${dir}`);
  return rows.reduce((t, r) => t + Number(r.v), 0);
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
const line = (qty: number) => ({ variantId: 1, productUnitId: 1, quantity: String(qty) });

describe("correctSale — تصحيح الفاتورة (عكس + إعادة ترحيل)", () => {
  beforeEach(async () => { await reset(); });

  it("تصحيح رفعٍ نقديّ بتحصيل الفرق: ١٠٠٠→٢٠٠٠ بدفعة ١٠٠٠ إضافية ⇒ الجديدة PAID، الأصل SUPERSEDED مربوط، الدفتر والمخزون صحيحان", async () => {
    await seed();
    const sale = await cashSale(1); // total 1000, paid 1000
    expect(await getStock(1, 1)).toBe(9);

    const res = await correctSale({
      originalInvoiceId: sale.invoiceId,
      lines: [line(2)], // صحّح لوحدتين ⇒ إجمالي ٢٠٠٠
      additionalPayment: { amount: "1000", method: "CASH" }, // النقص ١٠٠٠ يُحصَّل الآن
    }, admin);

    expect(res.correctedInvoiceId).not.toBe(sale.invoiceId);
    expect(money(res.total).toFixed(2)).toBe("2000.00");
    expect(money(res.overpay).toFixed(2)).toBe("0.00");

    // الأصل: SUPERSEDED، مصفَّر، مربوط بالجديدة.
    const orig = await getInvoice(sale.invoiceId);
    expect(orig.status).toBe("SUPERSEDED");
    expect(money(orig.paidAmount).toFixed(2)).toBe("0.00");
    expect(Number(orig.correctedByInvoiceId)).toBe(res.correctedInvoiceId);
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true); // SALE+RETURN=0

    // الجديدة: PAID، إيرادها ٢٠٠٠، مربوطةٌ بالأصل.
    const neu = await getInvoice(res.correctedInvoiceId);
    expect(neu.status).toBe("PAID");
    expect(money(neu.paidAmount).toFixed(2)).toBe("2000.00");
    expect(Number(neu.correctionOfInvoiceId)).toBe(sale.invoiceId);
    expect(money(await sumCol(res.correctedInvoiceId, "revenue")).toFixed(2)).toBe("2000.00");
    // الإيصالات على الجديدة: الأصليّ (١٠٠٠) مُنقَل + الإضافيّ (١٠٠٠) = ٢٠٠٠.
    expect(await receiptSum(res.correctedInvoiceId, "IN")).toBe(2000);
    expect(await receiptSum(res.correctedInvoiceId, "OUT")).toBe(0);
    // المخزون: بيع ١ (٩) ← عكس (١٠) ← بيع ٢ (٨) = صافي ٢ مخصومة.
    expect(await getStock(1, 1)).toBe(8);
  });

  it("تصحيح خفضٍ نقديّ باسترداد نقديّ: ١٠٠٠→٨٠٠ ⇒ الفرق ٢٠٠ يُردّ نقداً من الدرج، الجديدة PAID متّسقة", async () => {
    await seed();
    const sale = await cashSale(1); // paid 1000

    const res = await correctSale({
      originalInvoiceId: sale.invoiceId,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "200" }], // ١٠٠٠−٢٠٠=٨٠٠
      overpayHandling: "CASH_REFUND",
      priceOverrideApproved: true,
    }, admin);

    expect(money(res.total).toFixed(2)).toBe("800.00");
    expect(money(res.overpay).toFixed(2)).toBe("200.00");
    expect(res.overpayHandled).toBe("CASH_REFUND");

    const neu = await getInvoice(res.correctedInvoiceId);
    expect(neu.status).toBe("PAID");
    expect(money(neu.paidAmount).toFixed(2)).toBe("800.00");
    // الإيصالات: IN مُنقَل ١٠٠٠ − OUT استرداد ٢٠٠ = صافٍ ٨٠٠ = paidAmount.
    expect(await receiptSum(res.correctedInvoiceId, "IN")).toBe(1000);
    expect(await receiptSum(res.correctedInvoiceId, "OUT")).toBe(200);
    // الدفتر: الأصل صفر، الجديد ٨٠٠.
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(res.correctedInvoiceId, "revenue")).toFixed(2)).toBe("800.00");
  });

  it("تصحيح رفعٍ آجل جزئيّ المدفوع: بيع ٢٠٠٠ مدفوعٌ منه ٦٠٠ ثم تصحيح لـ٣٠٠٠ ⇒ ذمّة العميل ٢٤٠٠ (صحّة تصحيح AR)", async () => {
    await seed({ withCustomer: true });
    // بيع آجل لوحدتين (٢٠٠٠) بدفعة جزئية ٦٠٠ ⇒ يبقى مديناً ١٤٠٠.
    const sale = await createSale({ branchId: 1, customerId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
      lines: [line(2)], payment: { amount: "600", method: "CASH" } }, admin);
    expect(await getCustomerBalance(1)).toBe(1400);

    // صحّح لثلاث وحدات (٣٠٠٠)؛ المدفوع ٦٠٠ يُرحَّل ⇒ يبقى مديناً ٢٤٠٠.
    const res = await correctSale({ originalInvoiceId: sale.invoiceId, customerId: 1, lines: [line(3)] }, admin);
    expect(money(res.total).toFixed(2)).toBe("3000.00");

    expect(await getCustomerBalance(1)).toBe(2400); // ← الثابت الحرِج: صحّة تصحيح AR (+المدفوع)
    const neu = await getInvoice(res.correctedInvoiceId);
    expect(neu.status).toBe("PARTIALLY_PAID");
    expect(money(neu.paidAmount).toFixed(2)).toBe("600.00");
    expect(await receiptSum(res.correctedInvoiceId, "IN")).toBe(600); // الإيصال مُنقَل
    // الأصل: ذمّته أُزيلت، مصفَّر.
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
  });

  it("تصحيح خفضٍ آجلٍ مدفوعٍ كاملاً برصيدٍ دائن: بيع ١٠٠٠ مدفوعٌ كاملاً ثم تصحيح لـ٦٠٠ (CREDIT) ⇒ رصيد دائن ٤٠٠", async () => {
    await seed({ withCustomer: true });
    const sale = await createSale({ branchId: 1, customerId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
      lines: [line(1)], payment: { amount: "1000", method: "CASH" } }, admin);
    expect(await getCustomerBalance(1)).toBe(0);

    const res = await correctSale({ originalInvoiceId: sale.invoiceId, customerId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", discountAmount: "400" }], // ٦٠٠
      overpayHandling: "CREDIT", priceOverrideApproved: true }, admin);
    expect(money(res.total).toFixed(2)).toBe("600.00");
    expect(money(res.overpay).toFixed(2)).toBe("400.00");
    expect(res.overpayHandled).toBe("CREDIT");

    // العميل: دفع ١٠٠٠ لفاتورةٍ ٦٠٠ ⇒ رصيدٌ دائن ٤٠٠ (سالب = لصالحه).
    expect(await getCustomerBalance(1)).toBe(-400);
    const neu = await getInvoice(res.correctedInvoiceId);
    expect(neu.status).toBe("PAID");
    expect(money(neu.paidAmount).toFixed(2)).toBe("600.00");
    // الإيصالات: IN مُنقَل ١٠٠٠ − OUT رصيد ٤٠٠ = ٦٠٠ = paidAmount؛ والـOUT بلا مسٍّ للدرج (cashBucket null).
    expect(await receiptSum(res.correctedInvoiceId, "IN")).toBe(1000);
    expect(await receiptSum(res.correctedInvoiceId, "OUT")).toBe(400);
    const outR = (await db().select().from(s.receipts).where(sql`${s.receipts.invoiceId}=${res.correctedInvoiceId} AND ${s.receipts.direction}='OUT'`))[0];
    expect(outR.cashBucket).toBeNull();
  });

  it("idempotency: نفس المفتاح ⇒ إعادةٌ بلا تصحيحٍ ثانٍ (فاتورة واحدة جديدة)", async () => {
    await seed();
    const sale = await cashSale(1);
    const first = await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)], clientRequestId: "corr-key-1" }, admin);
    const again = await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)], clientRequestId: "corr-key-1" }, admin);
    expect(again.correctedInvoiceId).toBe(first.correctedInvoiceId);
    expect(again.idempotentReplay).toBe(true);
    // فاتورةٌ جديدةٌ واحدة فقط (لا تكرار).
    const superseded = await db().select({ id: s.invoices.id }).from(s.invoices).where(eq(s.invoices.status, "SUPERSEDED"));
    expect(superseded).toHaveLength(1);
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
    const s4 = await cashSale(1);
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
    }, admin)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
