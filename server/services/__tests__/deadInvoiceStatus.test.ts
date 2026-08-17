/**
 * عنقود «المستند الميت» — الحَكَم التجريبيّ للثابت الذي كسرته هجرة 0168.
 *
 * أُضيفت الحالة `SUPERSEDED` إلى enum الفاتورة (تصحيح الفاتورة) ولم تُضَف إلى المواضع التي
 * تفلتر المستندات الميتة. و`correct.ts` يترك الأصل بـ`total` كاملاً و`returnedTotal`
 * **مُصفَّراً صراحةً** ⇒ يبدو لكلّ قارئٍ غافلٍ بيعاً حيّاً كامل القيمة ومستحقّاً بالكامل.
 * كل اختبارٍ هنا يسقط على الشيفرة قبل إصلاح ١٧/٨.
 *
 * ويُثبت هذا الملف كذلك: عزل الفرع وحارس الحالة على `sales.correct`، وبقاء نسبة البيع
 * للبائع الأصليّ عند التصحيح، وفلتر «آجل» (`paymentMethod: "NONE"`).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale } from "../saleService";
import { correctSale } from "../sale/correct";
import { getSalesByDimension } from "../reportsSalesService";
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
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع", code: "BR2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "أدمن", role: "admin", loginMethod: "local" },
    { id: 2, openId: "local_mgr2", name: "مدير ٢", role: "manager", loginMethod: "local", branchId: 2 },
    { id: 3, openId: "local_cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "600.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
  await d.insert(s.shifts).values({ id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
  await d.insert(s.customers).values({ id: 1, name: "عميل", currentBalance: "0", creditLimit: "9999999.00" });
}
function makeCtx(user: unknown) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as any;
}
const line = (qty: number) => ({ variantId: 1, productUnitId: 1, quantity: String(qty) });

async function cashSale(qty: number, actor = admin) {
  return createSale({ branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
    lines: [line(qty)], payment: { amount: String(qty * 1000), method: "CASH" } }, actor);
}
async function creditSale(qty: number, actor = admin) {
  return createSale({ branchId: 1, customerId: 1, priceTier: "RETAIL", sourceType: "ORDER",
    lines: [line(qty)] }, actor);
}
const today = () => new Date().toISOString().slice(0, 10);

describe("المستند الميت — الفاتورة المُستبدَلة", () => {
  beforeEach(async () => { await reset(); await seed(); });

  it("لا تُضاعِف الإيراد ولا تُنتج ربحاً وهمياً في «المبيعات حسب البُعد»", async () => {
    const sale = await cashSale(2); // ٢٠٠٠
    await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(2)] }, admin);

    // الأصل صار SUPERSEDED بـtotal كاملاً وreturnedTotal مُصفَّراً — الفخّ بعينه.
    const original = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(original.status).toBe("SUPERSEDED");
    expect(money(original.total).toFixed(2)).toBe("2000.00");
    expect(money(original.returnedTotal ?? "0").toFixed(2)).toBe("0.00");

    const rep = await getSalesByDimension({ from: today(), to: today(), dimension: "branch" });
    // البيع وقع مرّةً واحدة ⇒ الإيراد ٢٠٠٠ لا ٤٠٠٠.
    expect(money(rep.totals.revenue).toFixed(2)).toBe("2000.00");
    // والربح = ٢٠٠٠ − (٢ × ٦٠٠) = ٨٠٠. قبل الإصلاح كان يضيف ٢٠٠٠ ربحاً بتكلفةٍ صفر (العكس أعاد البضاعة).
    expect(money(rep.totals.profit).toFixed(2)).toBe("800.00");
  });

  it("لا تظهر ضمن «عليها مبلغ متبقٍ» ولا «غير مدفوعة» في قائمة الفواتير", async () => {
    const sale = await creditSale(2); // ذمّة ٢٠٠٠ على العميل
    await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(2)], customerId: 1 }, admin);

    const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));
    for (const balanceState of ["OUTSTANDING", "UNPAID"] as const) {
      const rows = await caller.sales.list({ balanceState, limit: 50 });
      const ids = rows.map((r) => Number(r.id));
      expect(ids).not.toContain(sale.invoiceId); // الأصل الميت
      expect(ids.length).toBe(1); // البديلة وحدها تحمل الالتزام
    }
  });

  it("لا يُقبل ربط سند قبضٍ بها", async () => {
    const sale = await creditSale(2);
    await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(2)], customerId: 1 }, admin);

    const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));
    await expect(
      caller.vouchers.create({
        voucherType: "RECEIPT", partyType: "CUSTOMER", partyId: 1,
        amount: "500.00", paymentMethod: "CASH", branchId: 1,
        description: "قبض على فاتورة مستبدَلة",
        invoiceId: sale.invoiceId, clientRequestId: "vch-superseded-1",
      } as never),
    ).rejects.toThrow(/مستبدَلة|ملغاة|مرتجعة/);
  });

  it("لا تُرجَع منها — والرسالة توجّه إلى البديلة بدل خطأٍ تقنيّ غامض", async () => {
    const sale = await cashSale(2);
    await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(2)] }, admin);

    const { returnSale } = await import("../returnService");
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await expect(
      returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], restock: true }, admin),
    ).rejects.toThrow(/مستبدَلة/);
  });
});

describe("sales.correct — «تعديل البيانات»", () => {
  beforeEach(async () => { await reset(); await seed(); });

  it("مدير فرعٍ لا يعدّل بيانات فاتورة فرعٍ آخر", async () => {
    const sale = await creditSale(1); // فاتورة الفرع ١
    // مدير الفرع ٢ — يرى رقماً متسلسلاً ويستدعي الإجراء مباشرةً.
    const caller = appRouter.createCaller(makeCtx({ id: 2, role: "manager", branchId: 2 }));
    await expect(
      caller.sales.correct({ invoiceId: sale.invoiceId, dueDate: "2030-01-01", reason: "تغيير استحقاق" }),
    ).rejects.toThrow(/لا تخصّ فرعك/);
  });

  it("لا تُعدَّل بيانات فاتورة مستبدَلة (ذمّةٌ لا وجود لها)", async () => {
    const sale = await creditSale(1);
    await correctSale({ originalInvoiceId: sale.invoiceId, lines: [line(1)], customerId: 1 }, admin);

    const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));
    await expect(
      caller.sales.correct({ invoiceId: sale.invoiceId, dueDate: "2030-01-01", reason: "تغيير استحقاق" }),
    ).rejects.toThrow(/ملغاة أو مرتجعة أو مستبدَلة/);
  });
});

describe("نسبة البيع عند التصحيح", () => {
  beforeEach(async () => { await reset(); await seed(); });

  it("تبقى للبائع الأصليّ لا للمدير المصحِّح (وعاء العمولة يتبع invoices.createdBy)", async () => {
    // بيعٌ آجل بيد الكاشير (بلا وردية — الوردية ١ تخصّ الأدمن، والتسجيل عليها ممنوع بحقّ).
    const cashier = { userId: 3, branchId: 1, role: "cashier" as const };
    const sale = await creditSale(2, cashier);

    const before = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(Number(before.createdBy)).toBe(3);
    expect(before.salespersonNameSnapshot).toBe("كاشير");

    // المدير (userId 1) يصحّح كميةً — بلا فرقٍ ماليّ (٢ ⇒ ٢) كي يبقى الاختبار على النسبة وحدها.
    const res = await correctSale(
      { originalInvoiceId: sale.invoiceId, lines: [line(2)], customerId: 1 },
      admin,
    );

    const corrected = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.correctedInvoiceId)))[0];
    expect(Number(corrected.createdBy)).toBe(3); // الكاشير — لا المدير
    expect(corrected.salespersonNameSnapshot).toBe("كاشير");
  });
});

describe("فلتر «آجل» في قائمة الفواتير", () => {
  beforeEach(async () => { await reset(); await seed(); });

  it("paymentMethod=NONE يُرجع الفواتير الآجلة وحدها (paymentMethod IS NULL)", async () => {
    const credit = await creditSale(1); // بلا دفعة ⇒ paymentMethod = NULL
    const cash = await cashSale(1); // نقديّ ⇒ CASH

    const caller = appRouter.createCaller(makeCtx({ id: 1, role: "admin", branchId: 1 }));
    const none = await caller.sales.list({ paymentMethod: "NONE", limit: 50 });
    expect(none.map((r) => Number(r.id))).toEqual([credit.invoiceId]);

    const cashOnly = await caller.sales.list({ paymentMethod: "CASH", limit: 50 });
    expect(cashOnly.map((r) => Number(r.id))).toEqual([cash.invoiceId]);

    // الثابت العمليّ: مجموع الطرق + الآجل = الكل (كان الفارق غير قابلٍ للعرض إطلاقاً).
    const all = await caller.sales.list({ limit: 50 });
    expect(all.length).toBe(none.length + cashOnly.length);
  });
});
