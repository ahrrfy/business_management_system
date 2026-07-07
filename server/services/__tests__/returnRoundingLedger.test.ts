/**
 * F6 (تدقيق ٢/٧) — اختبار توصيف: تصافُر الدفتر (الإيراد/الربح) عند المرتجع الكامل لبيعٍ نقديّ مقرَّب IQD.
 *
 * **الثابت الفعليّ (كشفه هذا الاختبار):** بعد المرتجع الكامل، Σ(revenue WHERE invoiceId) = 0
 * و Σ(profit WHERE invoiceId) = 0 — الإيراد والربح يُعكَسان بالكامل، والتقريب النقدي يُعكَس بالضبط
 * مرّة واحدة (قيد ADJUST إنشاءٍ بـ−adj + قيد ADJUST مرتجعٍ بـ+adj) ⇒ لا بقايا تقريب في P&L، ولا عكس مزدوج.
 *
 * **لماذا ليس Σ(amount):** عمود `amount` لقيود النقد (PAYMENT_IN/OUT) غير مُوقَّع (الاتجاه في entryType
 * لا في الإشارة) ⇒ الدفع والاسترداد كلاهما amount موجب فلا يُلغيان، وSUM(amount) ≠ 0 بالتصميم.
 * الثابت المحاسبيّ الحقيقيّ (أثر P&L) هو تصافُر revenue/profit — وهو ما يحرسه هذا الاختبار.
 * (الوثيقة قالت «amount» تجاوزاً؛ المقصود تصافُر الدفتر = revenue/profit، وقد أُثبِت هنا فعلياً على DB.)
 */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { processPayment } from "../sale/payment";
import { money } from "../money";

const actor = { userId: 1, branchId: 1 };

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
async function seed(unitPrice: string) {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "400.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: unitPrice }]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
  await d.insert(s.shifts).values({ id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
}

async function sumCol(invoiceId: number, col: "revenue" | "profit" | "amount"): Promise<number> {
  const rows = await db()
    .select({ v: s.accountingEntries[col] })
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.invoiceId, invoiceId));
  return rows.reduce((t, r) => t + Number(r.v), 0);
}

describe("F6 — تصافُر الدفتر عند المرتجع الكامل للبيع المقرَّب IQD", () => {
  it("بيع نقديّ مقرَّب (١٣٠٠ ⇒ ١٢٥٠، تقريب −٥٠) ثم مرتجع كامل ⇒ Σ(revenue)=Σ(profit)=0، والتقريب مُعكَّس مرّة واحدة", async () => {
    await reset();
    await seed("1300.00");
    // tendered ≥ الإجمالي ⇒ paidNow = effectiveTotal (١٢٥٠). invoice.total يُخزَّن مقرَّباً (١٢٥٠).
    const sale = await createSale(
      { branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "1300.00", method: "CASH" }, cashRoundIQD: true },
      actor,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.total).toBe("1250.00"); // الإجمالي المُخزَّن = المقرَّب (النقد المستلم)
    expect(inv.cashRoundingAdjustment).toBe("-50.00");

    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    const ret = await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        refund: { amount: "1250.00", method: "CASH" }, restock: true },
      actor,
    );
    expect(ret.fullyReturned).toBe(true);

    // الثابت المحاسبيّ: الإيراد والربح يتصافران بالكامل ⇒ صفر أثر P&L من البيع المُرتجَع كلياً.
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "profit")).isZero()).toBe(true);

    // التقريب مُعكَّس بالضبط مرّة واحدة: قيدا ADJUST (−٥٠ إنشاء، +٥٠ مرتجع) يتصافران في revenue وamount.
    const adjs = await db().select().from(s.accountingEntries)
      .where(sql`${s.accountingEntries.invoiceId}=${sale.invoiceId} AND ${s.accountingEntries.entryType}='ADJUST'`);
    expect(adjs).toHaveLength(2);
    expect(money(adjs.reduce((t, e) => t + Number(e.revenue), 0)).isZero()).toBe(true);
    expect(money(adjs.reduce((t, e) => t + Number(e.amount), 0)).isZero()).toBe(true);

    // النقد يتعادل: PAYMENT_IN (١٢٥٠) و PAYMENT_OUT (١٢٥٠) — المستلَم = المُسترَدّ (الدُرج يعود صفراً لهذه الفاتورة).
    const inSum = (await db().select().from(s.receipts).where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='IN'`)).reduce((t, r) => t + Number(r.amount), 0);
    const outSum = (await db().select().from(s.receipts).where(sql`${s.receipts.invoiceId}=${sale.invoiceId} AND ${s.receipts.direction}='OUT'`)).reduce((t, r) => t + Number(r.amount), 0);
    expect(inSum).toBe(1250);
    expect(outSum).toBe(1250);
  });

  it("بيع نقديّ غير مقرَّب (control) ثم مرتجع كامل ⇒ Σ(revenue)=Σ(profit)=0، بلا أي قيد ADJUST", async () => {
    await reset();
    await seed("1000.00"); // ١٠٠٠ مضاعف ٢٥٠ ⇒ لا تقريب (adj=0)
    const sale = await createSale(
      { branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "1000.00", method: "CASH" }, cashRoundIQD: true },
      actor,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.cashRoundingAdjustment).toBe("0.00");

    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        refund: { amount: "1000.00", method: "CASH" }, restock: true },
      actor,
    );
    expect(money(await sumCol(sale.invoiceId, "revenue")).isZero()).toBe(true);
    expect(money(await sumCol(sale.invoiceId, "profit")).isZero()).toBe(true);
    const adjs = await db().select().from(s.accountingEntries)
      .where(sql`${s.accountingEntries.invoiceId}=${sale.invoiceId} AND ${s.accountingEntries.entryType}='ADJUST'`);
    expect(adjs).toHaveLength(0);
  });
});

// #1 (تدقيق التثبيت): بعد مرتجع جزئي، «المتبقّي» الحقيقي = total − returnedTotal − paidAmount.
// كانت الواجهة تعرض total − paidAmount (تتجاهل المرتجعات) فتُملّئ مبلغاً أكبر وتُضلّل الكاشير لتحصيلٍ
// زائد غير مقصود ⇒ رصيد عميل سالب. الإصلاح واجهيّ (العرض) لا خادميّ — «الدفع الزائد المتعمَّد مسموح»
// قرار مالك (financialPolicies السياسة ٦)، فلا نمنعه خادمياً؛ فقط نُصلِح ما يُملأ تلقائياً.
describe("#1 — المتبقّي المعروض يطرح المرتجعات (لا تضليل لتحصيل زائد)", () => {
  it("بيع آجل ٢٠٠٠ ثم مرتجع جزئي ١٠٠٠ ⇒ المتبقّي المعروض = ١٠٠٠ (لا ٢٠٠٠)، ودفعه يُصفّي الذمة", async () => {
    await reset();
    await seed("1000.00");
    await db().insert(s.customers).values({ id: 1, name: "عميل آجل", currentBalance: "0", creditLimit: "9999999.00" });
    // بيع آجل (بلا payment) لوحدتين ⇒ total=2000، PENDING، AR=2000.
    const sale = await createSale(
      { branchId: 1, customerId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }] },
      actor,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
    // مرتجع وحدة واحدة بلا ردّ نقدي ⇒ returnedTotal=1000، AR=1000.
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }], restock: true },
      actor,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv.returnedTotal).toBe("1000.00");
    // المتبقّي الحقيقي الذي تعرضه الواجهة بعد الإصلاح = total − returnedTotal − paidAmount = 1000
    // (كان العطل: تعرض total − paidAmount = 2000 فتُضلّل الكاشير لتحصيلٍ زائد بمقدار المرتجع).
    const netRemaining = money(inv.total).minus(money(inv.returnedTotal ?? "0")).minus(money(inv.paidAmount));
    expect(netRemaining.toFixed(2)).toBe("1000.00");

    // دفع المتبقّي الحقيقي (١٠٠٠) — الذي يقود إليه العرض المُصلَح — يُصفّي الفاتورة والذمة إلى صفر.
    await processPayment({ invoiceId: sale.invoiceId, amount: "1000.00", method: "CASH" }, actor);
    const inv2 = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(inv2.status).toBe("PAID");
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(money(cust.currentBalance).toFixed(2)).toBe("0.00");
  });
});
