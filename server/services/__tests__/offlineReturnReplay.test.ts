/**
 * المرتجع الأوفلاينيّ — البند الرابع من تدقيق ١/٩/٢٦ («الأوفلاين بلا مرتجع»).
 *
 * الجهازُ المنقطع لم يكن يملك مرتجعاً ولا طابوراً له، فالزبونُ يعود ببضاعته أثناء الانقطاع
 * ولا مسارَ أمام الموظّف إلّا الدفعُ من خارج النظام — مصدرُ النقد اليتيم والعجزُ غير المفسَّر.
 *
 * ما يُثبته هذا الملفّ: الترحيلُ يُنتج **أثراً كاملاً** (مخزون + قيد + إيصال يمسّ الدرج)،
 * وأنّ حرّاسه ليست تجميلاً: السلطة والنافذة والنقديّة و`idempotency` كلّها نافذة.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { replayOfflineReturn } from "../offline/replayReturn";
import { OFFLINE_CAPTURE_MAX_AGE_MS } from "../offline/captureWindow";
import { ensureFinancialPostingGate } from "../reports/monthCloseGate";

const TABLES = [
  "salesControlRequests", "returnRequests", "idempotencyKeys", "auditLogs",
  "accountingEntries", "receipts", "invoiceItems", "invoices",
  "inventoryMovements", "branchStock", "productPrices", "productUnits",
  "productVariants", "products", "shifts", "customers", "branches", "users",
];

const OWNER = { userId: 5, branchId: 1, role: "admin" };
const MANAGER = { userId: 1, branchId: 1, role: "manager" };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}
const stockOf = async (variantId = 1) =>
  Number((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, variantId)))[0]?.quantity ?? 0);

beforeEach(async () => {
  const d = db();
  await d.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const table of TABLES) await tx.execute(sql.raw(`DELETE FROM \`${table}\``));
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });
  await ensureFinancialPostingGate(d);
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "m1", name: "مدير", email: "m1@o.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 5, openId: "o1", name: "المالك", email: "o1@o.test", role: "admin", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل", phone: "+9647701111111", currentBalance: "0.00" });
  await d.insert(s.products).values({ id: 1, name: "دفتر" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB", costPrice: "400.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
  await d.insert(s.shifts).values({ id: 1, branchId: 1, userId: 5, openingBalance: "10000", status: "OPEN" });
});

async function paidSale() {
  return createSale({
    branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
    payment: { amount: "5000.00", method: "CASH" },
  }, OWNER);
}

async function firstItemId(invoiceId: number) {
  const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId));
  return Number(item.id);
}

const base = (invoiceId: number, invoiceItemId: number) => ({
  invoiceId,
  lines: [{ invoiceItemId, baseQuantity: 5 }],
  refund: { amount: "5000.00", method: "CASH" as const, shiftId: 1 },
  restock: true,
  reason: "الزبون أعاد البضاعة أثناء انقطاع الشبكة",
  capturedAt: new Date().toISOString(),
  offlineReceiptNumber: "OFF-1-0001",
});

describe("المرتجع الأوفلاينيّ — الترحيل يُنتج أثراً كاملاً", () => {
  it("⭐ ترحيلٌ ناجح: المخزون يعود · قيد RETURN يُكتب · إيصال OUT يمسّ الدرج", async () => {
    const sale = await paidSale();
    const itemId = await firstItemId(sale.invoiceId);
    expect(await stockOf()).toBe(95);

    const out = await replayOfflineReturn(
      { ...base(sale.invoiceId, itemId), clientRequestId: "off-ret-1" },
      OWNER,
    );
    expect(out.fullyReturned).toBe(true);

    expect(await stockOf()).toBe(100);
    const entries = await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, sale.invoiceId),
      eq(s.accountingEntries.entryType, "RETURN"),
    ));
    expect(entries.length).toBe(1);
    const outReceipts = await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, sale.invoiceId),
      eq(s.receipts.direction, "OUT"),
    ));
    expect(outReceipts.length).toBe(1);
    // يمسّ الدرج فعلاً ⇒ يدخل computeExpectedCash فلا يظهر عجزٌ مكتوم في Z-report.
    expect(outReceipts[0].cashBucket).toBe("DRAWER");
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0].status).toBe("RETURNED");
  });

  it("idempotency: نفس clientRequestId مرّتين ⇒ مرتجعٌ واحد ولا نقدَ مزدوج", async () => {
    const sale = await paidSale();
    const itemId = await firstItemId(sale.invoiceId);
    const payload = { ...base(sale.invoiceId, itemId), clientRequestId: "off-ret-dup" };

    await replayOfflineReturn(payload, OWNER);
    await replayOfflineReturn(payload, OWNER); // إعادةُ محاولةٍ بعد انقطاع الردّ

    expect(await stockOf()).toBe(100); // لا زيادةَ مضاعفة
    const outReceipts = await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, sale.invoiceId),
      eq(s.receipts.direction, "OUT"),
    ));
    expect(outReceipts.length).toBe(1); // ولا إيصالُ ردٍّ ثانٍ
  });

  it("السلطة تُقرأ داخل المعاملة: غيرُ المالك يُرفض بصفر أثر", async () => {
    const sale = await paidSale();
    const itemId = await firstItemId(sale.invoiceId);

    await expect(replayOfflineReturn(
      { ...base(sale.invoiceId, itemId), clientRequestId: "off-ret-mgr" },
      MANAGER,
    )).rejects.toThrow(/بحساب مالكٍ نشط/);
    expect(await stockOf()).toBe(95);

    // ومالكٌ عُطِّل بين الالتقاط والترحيل يُرفض كذلك — الرايةُ لا تُقرأ من الجلسة.
    await db().update(s.users).set({ isActive: false }).where(eq(s.users.id, 5));
    await expect(replayOfflineReturn(
      { ...base(sale.invoiceId, itemId), clientRequestId: "off-ret-inactive" },
      OWNER,
    )).rejects.toThrow(/بحساب مالكٍ نشط/);
    expect(await stockOf()).toBe(95);
  });

  it("حرّاس الالتقاط نافذة: نافذةٌ منتهية · لحظةٌ مستقبليّة · سببٌ ناقص · ردٌّ غير نقديّ", async () => {
    const sale = await paidSale();
    const itemId = await firstItemId(sale.invoiceId);
    const b = base(sale.invoiceId, itemId);

    await expect(replayOfflineReturn({
      ...b,
      capturedAt: new Date(Date.now() - OFFLINE_CAPTURE_MAX_AGE_MS - 60_000).toISOString(),
      clientRequestId: "off-ret-old",
    }, OWNER)).rejects.toThrow(/أقدم من ٧٢ ساعة/);

    await expect(replayOfflineReturn({
      ...b,
      capturedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      clientRequestId: "off-ret-future",
    }, OWNER)).rejects.toThrow(/المستقبل/);

    await expect(replayOfflineReturn({
      ...b, reason: "لا", clientRequestId: "off-ret-noreason",
    }, OWNER)).rejects.toThrow(/سبب المرتجع الأوفلاينيّ إلزاميّ/);

    await expect(replayOfflineReturn({
      ...b,
      refund: { amount: "5000.00", method: "CARD" as unknown as "CASH", shiftId: 1 },
      clientRequestId: "off-ret-card",
    }, OWNER)).rejects.toThrow(/نقدي فقط/);

    expect(await stockOf()).toBe(95); // صفرُ أثرٍ من كلّ المحاولات المرفوضة
  });

  it("⭐ الزبون العابر: الترحيل يبني resolution فينجح — كان يفشل حتماً بـrefund وحده", async () => {
    // فاتورةٌ بلا عميل مسجَّل = الحالةُ الأكثر شيوعاً في التجزئة.
    const sale = await createSale({
      branchId: 1, shiftId: 1, sourceType: "POS", customerId: null,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      payment: { amount: "5000.00", method: "CASH" },
    }, OWNER);
    const itemId = await firstItemId(sale.invoiceId);
    expect(await stockOf()).toBe(95);

    const out = await replayOfflineReturn(
      { ...base(sale.invoiceId, itemId), clientRequestId: "off-ret-walkin" },
      OWNER,
    );
    expect(out.fullyReturned).toBe(true);
    expect(await stockOf()).toBe(100);
    // والسببُ الملتقَط يُحفَظ في نصّ القيد لا في سجلّ التدقيق وحده.
    const [entry] = await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, sale.invoiceId),
      eq(s.accountingEntries.entryType, "RETURN"),
    ));
    expect(entry.notes).toContain("سبب المرتجع=");
  });

  it("سببُ المالك يُحفَظ في نصّ القيد للعميل المسجَّل أيضاً — لا في التدقيق وحده", async () => {
    const sale = await paidSale(); // customerId = 1 (مسجَّل)
    const itemId = await firstItemId(sale.invoiceId);
    await replayOfflineReturn(
      { ...base(sale.invoiceId, itemId), reason: "سببٌ محفوظٌ في المستند", clientRequestId: "off-ret-reason" },
      OWNER,
    );
    const [entry] = await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, sale.invoiceId),
      eq(s.accountingEntries.entryType, "RETURN"),
    ));
    expect(entry.notes).toContain("سببٌ محفوظٌ في المستند");
  });

  it("سقفُ الاسترداد يُقيَّم خادمياً عند الترحيل — لا على الجهاز", async () => {
    const sale = await paidSale();
    const itemId = await firstItemId(sale.invoiceId);
    // الجهازُ التقط ردّاً يتجاوز ما قُبض على الفاتورة (سقفُه لا يُقيَّم أوفلاين).
    await expect(replayOfflineReturn({
      ...base(sale.invoiceId, itemId),
      refund: { amount: "9000.00", method: "CASH" as const, shiftId: 1 },
      clientRequestId: "off-ret-overcap",
    }, OWNER)).rejects.toThrow();
    // يرتدّ بصفر أثر ⇒ يُعلَّق في طابور الاسترداد بقناة RETURN لمراجعة المدير.
    expect(await stockOf()).toBe(95);
    const outReceipts = await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, sale.invoiceId),
      eq(s.receipts.direction, "OUT"),
    ));
    expect(outReceipts.length).toBe(0);
  });
});
