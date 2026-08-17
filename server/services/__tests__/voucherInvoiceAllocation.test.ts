/**
 * تخصيص سند العميل لفاتورته — إغلاق خطر **التحصيل المزدوج**.
 *
 * قبل الإصلاح: `createVoucher` يخزّن `receipts.invoiceId` ويُرحّل القيد ويُنقص رصيد العميل،
 * ولا يمسّ `invoices.paidAmount`. فـ`sales.pay` يشتقّ المتبقّي من `paidAmount` وحده ⇒ يُقبَض
 * المبلغ نفسه مرّتين بلا حارس؛ وشاشةُ الفاتورة تعرض الإيصال في «سجلّ الدفعات» وفوقه
 * «المدفوع: ٠» — تناقضٌ على شاشةٍ واحدة.
 *
 * كل اختبارٍ هنا يسقط على الشيفرة قبل إصلاح ١٧/٨.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale } from "../saleService";
import { createVoucher } from "../voucherService";
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
async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "local_admin", name: "أدمن", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "600.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
  await d.insert(s.shifts).values({ id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
  await d.insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0", creditLimit: "9999999.00" });
}
const line = (qty: number) => ({ variantId: 1, productUnitId: 1, quantity: String(qty) });
function makeCtx(user: unknown) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
/** فاتورة آجلة بـ(qty × ١٠٠٠) على العميل ١. */
async function creditSale(qty: number) {
  return createSale({ branchId: 1, customerId: 1, priceTier: "RETAIL", sourceType: "ORDER", lines: [line(qty)] }, admin);
}
async function getInvoice(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
async function customerBalance() {
  return money((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance ?? "0");
}
/** سند قبضٍ مربوطٌ بفاتورة. */
async function receiptVoucher(invoiceId: number | null, amount: string, key: string) {
  return createVoucher(
    {
      voucherType: "RECEIPT", branchId: 1, amount, paymentMethod: "CASH",
      partyType: "CUSTOMER", partyId: 1, description: "قبض على الحساب",
      ...(invoiceId != null ? { invoiceId } : {}),
      clientRequestId: key,
    } as never,
    admin,
  );
}

describe("سند القبض المربوط بفاتورة — تخصيصٌ ماليّ لا حاشية توثيقية", () => {
  beforeEach(async () => { await reset(); await seed(); });

  it("يُحرّك paidAmount والحالة، فلا تتناقض الشاشة مع سجلّ دفعاتها", async () => {
    const sale = await creditSale(2); // ٢٠٠٠ ذمّة
    expect(money((await getInvoice(sale.invoiceId)).paidAmount).toFixed(2)).toBe("0.00");

    await receiptVoucher(sale.invoiceId, "2000.00", "vch-alloc-1");

    const inv = await getInvoice(sale.invoiceId);
    expect(money(inv.paidAmount).toFixed(2)).toBe("2000.00");
    expect(inv.status).toBe("PAID");
    // ورصيد العميل صفرٌ (لم يُخصَم مرّتين — التخصيص والرصيد أثران متمايزان لا مزدوجان).
    expect((await customerBalance()).toFixed(2)).toBe("0.00");
  });

  it("⭐ يمنع التحصيل المزدوج: sales.pay يرفض بعد سدادٍ كاملٍ بسند", async () => {
    const sale = await creditSale(2);
    await receiptVoucher(sale.invoiceId, "2000.00", "vch-alloc-2");

    const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));
    // قبل الإصلاح كان هذا ينجح ⇒ يُقبض ٢٠٠٠ مرّةً ثانية ورصيد العميل ينقلب −٢٠٠٠.
    await expect(
      caller.sales.pay({
        invoiceId: sale.invoiceId, amount: "2000.00", method: "CASH",
        shiftId: 1, clientRequestId: "pay-double-1",
      } as never),
    ).rejects.toThrow(/مدفوعة بالكامل|لا يوجد مبلغ مستحق/);

    expect((await customerBalance()).toFixed(2)).toBe("0.00"); // لم يُقبض شيءٌ زائد
  });

  it("السداد الجزئي بسند يترك الباقي مستحقّاً ويقبله sales.pay بالضبط", async () => {
    const sale = await creditSale(2); // ٢٠٠٠
    await receiptVoucher(sale.invoiceId, "500.00", "vch-alloc-3");

    let inv = await getInvoice(sale.invoiceId);
    expect(money(inv.paidAmount).toFixed(2)).toBe("500.00");
    expect(inv.status).toBe("PARTIALLY_PAID");

    const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));
    // الزائد على المتبقّي يُرفض…
    await expect(
      caller.sales.pay({ invoiceId: sale.invoiceId, amount: "1600.00", method: "CASH", shiftId: 1, clientRequestId: "pay-over" } as never),
    ).rejects.toThrow(/تتجاوز المتبقي/);
    // …والمطابق يُقبل.
    await caller.sales.pay({ invoiceId: sale.invoiceId, amount: "1500.00", method: "CASH", shiftId: 1, clientRequestId: "pay-exact" } as never);

    inv = await getInvoice(sale.invoiceId);
    expect(money(inv.paidAmount).toFixed(2)).toBe("2000.00");
    expect(inv.status).toBe("PAID");
    expect((await customerBalance()).toFixed(2)).toBe("0.00");
  });

  it("سندٌ يتجاوز متبقّي الفاتورة يُرفَض برسالةٍ تدلّ على البديل (لا تقصيصَ صامت)", async () => {
    const sale = await creditSale(1); // ١٠٠٠
    await expect(receiptVoucher(sale.invoiceId, "1500.00", "vch-over-1")).rejects.toThrow(
      /يتجاوز المتبقّي على الفاتورة/,
    );
    // الفاتورة لم تُمسّ، ولا رصيد العميل — المعاملة ذرّية.
    expect(money((await getInvoice(sale.invoiceId)).paidAmount).toFixed(2)).toBe("0.00");
    expect((await customerBalance()).toFixed(2)).toBe("1000.00");
  });

  it("السند غير المربوط يبقى على الحساب ولا يمسّ أيّ فاتورة (سلوكٌ محفوظ)", async () => {
    const sale = await creditSale(2);
    await receiptVoucher(null, "800.00", "vch-unlinked-1");

    expect(money((await getInvoice(sale.invoiceId)).paidAmount).toFixed(2)).toBe("0.00");
    expect((await customerBalance()).toFixed(2)).toBe("1200.00"); // ٢٠٠٠ − ٨٠٠
  });

  it("لا يُخصَّص لفاتورةٍ ميتة", async () => {
    const sale = await creditSale(1);
    await db().update(s.invoices).set({ status: "CANCELLED" }).where(eq(s.invoices.id, sale.invoiceId));
    await expect(receiptVoucher(sale.invoiceId, "500.00", "vch-dead-1")).rejects.toThrow(
      /ملغاة أو مرتجعة أو مستبدَلة/,
    );
  });
});
