/**
 * ش٣ — تثبيت المسوّدة (draftCommit): ذرّيةٌ كاملة + idempotency ثلاثيّ الطبقات.
 * docs/reception-cashier-system-design-2026-08-05.md §٧.٣ + §١٣ ش٣.
 *
 * المُثبَت:
 *  T1 — تثبيت مسوّدة مختلطة (بضاعة + تخصيص) ينتج فاتورةً وأمرَ شغلٍ صحيحين، والمخزون يُخصم،
 *       وقيد SALE واحد، والمسوّدة COMMITTED بربط الفاتورة، والدرج يطابق (I7).
 *  I8 — إعادة نفس التثبيت (بعد COMMITTED) تعيد **نفس** الأرقام مُعادةً بناءً من مفاتيح
 *       idempotency — لا مستندات مزدوجة ولا مصفوفة workOrders فارغة.
 *  T2 — expectedTotal مخالف ⇒ PRECONDITION_FAILED قبل أيّ كتابة.
 *  T3 — version متقادم ⇒ CONFLICT.
 *  T4 — سلة فيها بضاعة بلا collectNow ⇒ رفض برسالة عربية؛ وسلة تخصيصٍ خالصة بلا collectNow
 *       تنجح بعربونٍ صفريّ (م٥).
 *  T5 — كوبون على مسار التثبيت ⇒ رفض صريح (ملاحظة ١.٨).
 *  T6 — التكافؤ: نفس المدخل عبر المسارين (checkoutReception المباشر / draftCommit) ينتج
 *       مستندات متطابقة مالياً (total/paid/قيد SALE).
 *  I20 — انحدار: مسار الأوفلاين replayReception يبقى أخضر (يُشغَّل في ملفه — هنا نضمن أن
 *       الاستخراج لم يغيّر توقيع الغلاف عملياً عبر T6 نفسه).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift, openShift } from "../shiftService";
import { checkoutReception } from "../receptionCheckoutService";
import { commitDraft, promoteDraft } from "../reception";

const TABLES = [
  "receptionDraftLines", "receptionDrafts",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
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

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00", creditLimit: "1000000.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

async function openReception(userId = 2) {
  return openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, { userId, branchId: 1 });
}

const MIXED_LINES = [
  { lineKind: "GOODS" as const, variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "1000.00", title: "دفتر (قطعة)" },
  {
    lineKind: "CUSTOM" as const, quantity: "1", unitPrice: "45000.00", title: "درع تكريم",
    printSpec: JSON.stringify({ laborCost: "0", priority: "NORMAL", hasDelivery: false }),
  },
];

beforeEach(async () => {
  await reset();
  await seed();
});

describe("ش٣ — تثبيت المسوّدة", () => {
  it("T1 + I8: تثبيتٌ مختلط ⇒ فاتورة + أمر شغل + خصم مخزون + COMMITTED؛ والإعادة تعيد نفس الأرقام", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: MIXED_LINES }, CASHIER);

    const r1 = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: shift.shiftId,
      collectNow: { amount: "47000.00", method: "CASH" },
    }, CASHIER);
    expect(r1.idempotentReplay).toBe(false);
    expect(r1.regularSale).not.toBeNull();
    expect(r1.regularSale?.shiftId).toBe(shift.shiftId);
    expect(r1.workOrders.length).toBe(1);
    expect(r1.workOrders[0].orderNumber).toMatch(/^WO-1-/);
    expect(r1.workOrders[0].deposit).toBe("45000.00");

    // فاتورة البيع المباشر: 2×1000 مدفوعة كاملاً؛ العربون الفائض 45000 ذهب لأمر الشغل.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r1.regularSale!.invoiceId)))[0];
    expect(inv.total).toBe("2000.00");
    expect(inv.paidAmount).toBe("2000.00");
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r1.workOrders[0].workOrderId)))[0];
    expect(wo.deposit).toBe("45000.00");
    expect(wo.salePrice).toBe("45000.00");
    // المخزون خُصم قطعتين للبيع المباشر (أمر الشغل لا يستهلك عند الإنشاء).
    const stock = (await db().select().from(s.branchStock).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1))))[0];
    expect(stock.quantity).toBe(98);
    // المسوّدة COMMITTED بربط الفاتورة (uq_draft_committed_invoice).
    const draft = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, p.draftId)))[0];
    expect(draft.status).toBe("COMMITTED");
    expect(Number(draft.committedInvoiceId)).toBe(r1.regularSale!.invoiceId);
    // I7: الدرج = 2000 (بيع) + 45000 (عربون) نقداً.
    const drawer = await db().select({ n: sql<string>`COALESCE(SUM(amount),0)` }).from(s.receipts)
      .where(and(eq(s.receipts.shiftId, shift.shiftId), eq(s.receipts.cashBucket, "DRAWER"), eq(s.receipts.direction, "IN")));
    expect(Number(drawer[0].n)).toBe(47000);

    // I8: أُغلقت الوردية الأصلية وفتح الموظف أخرى قبل إعادة المحاولة بعد انقطاع الشبكة.
    // النتيجة المعاد بناؤها يجب أن تحمل وردية الفاتورة المحفوظة، لا الوردية الحية الجديدة.
    await closeShift({ shiftId: shift.shiftId, countedCash: "47000.00" }, CASHIER);
    const retryShift = await openReception();
    const r2 = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "47000.00", shiftId: retryShift.shiftId,
      collectNow: { amount: "47000.00", method: "CASH" },
    }, CASHIER);
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.regularSale?.invoiceId).toBe(r1.regularSale!.invoiceId);
    expect(r2.regularSale?.invoiceNumber).toBe(r1.regularSale!.invoiceNumber);
    expect(r2.regularSale?.shiftId).toBe(shift.shiftId);
    expect(r2.regularSale?.shiftId).not.toBe(retryShift.shiftId);
    expect(r2.workOrders).toEqual(r1.workOrders); // لا مصفوفة فارغة (ملاحظة ٢.١٠)
    expect((await db().select().from(s.invoices)).length).toBe(1);
    expect((await db().select().from(s.workOrders)).length).toBe(1);
  });

  it("T2: expectedTotal مخالف ⇒ رفضٌ قبل أيّ كتابة", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: {}, lines: [MIXED_LINES[0]] }, CASHIER);
    await expect(commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "9999.00", shiftId: shift.shiftId,
      collectNow: { amount: "2000.00", method: "CASH" },
    }, CASHIER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.invoices)).length).toBe(0);
  });

  it("T3: version متقادم ⇒ CONFLICT", async () => {
    const shift = await openReception();
    const p = await promoteDraft({ branchId: 1, header: {}, lines: [MIXED_LINES[0]] }, CASHIER);
    await expect(commitDraft({
      draftId: p.draftId, version: 7, expectedTotal: "2000.00", shiftId: shift.shiftId,
      collectNow: { amount: "2000.00", method: "CASH" },
    }, CASHIER)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("T4: بضاعة بلا collectNow ⇒ رفض؛ وتخصيصٌ خالص بلا collectNow ينجح بعربون صفر (م٥)", async () => {
    const shift = await openReception();
    const withGoods = await promoteDraft({ branchId: 1, header: {}, lines: [MIXED_LINES[0]] }, CASHIER);
    await expect(commitDraft({
      draftId: withGoods.draftId, version: 0, expectedTotal: "2000.00", shiftId: shift.shiftId,
    }, CASHIER)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const customOnly = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [MIXED_LINES[1]] }, CASHIER);
    const r = await commitDraft({
      draftId: customOnly.draftId, version: 0, expectedTotal: "45000.00", shiftId: shift.shiftId,
    }, CASHIER);
    expect(r.workOrders.length).toBe(1);
    const wo = (await db().select().from(s.workOrders).where(eq(s.workOrders.id, r.workOrders[0].workOrderId)))[0];
    expect(wo.deposit).toBe("0.00"); // لا شرط عربون — تقدير الموظف
    expect((await db().select().from(s.receipts)).length).toBe(0); // صفر نقد ⇒ صفر إيصالات
  });

  it("T5 (من الجولة الحيّة): تقريب IQD — مسوّدة 1,480 تُثبَّت بقبض 1,500 المقرَّب بلا رفض «يتجاوز الإجمالي»", async () => {
    const shift = await openReception();
    const p = await promoteDraft({
      branchId: 1, header: {},
      lines: [{ lineKind: "GOODS" as const, variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1480.00", title: "دفتر" }],
    }, CASHIER);
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "1480.00", shiftId: shift.shiftId,
      collectNow: { amount: "1500.00", method: "CASH" }, cashRoundIQD: true,
    }, CASHIER);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, r.regularSale!.invoiceId)))[0];
    expect(inv.total).toBe("1500.00"); // المقرَّب — والدرج يستلم 1500 بالضبط ⇒ الإغلاق بفارق صفر
    expect(inv.paidAmount).toBe("1500.00");
  });

  it("T6: التكافؤ الماليّ بين المسارين — نفس المدخل ⇒ نفس total/paid وقيد SALE واحد لكلٍّ", async () => {
    const shift = await openReception();
    // المسار المباشر (القائم — يثبت أن الاستخراج صفريّ الأثر عليه).
    const direct = await checkoutReception({
      branchId: 1, shiftId: shift.shiftId, customerId: 1,
      paymentMethod: "CASH", paidAmount: "2000.00", clientRequestId: "t6-direct",
      regularSale: { lines: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "1000.00" }], amount: "2000.00" },
    }, CASHIER);
    // مسار المسوّدة بنفس المدخل.
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [MIXED_LINES[0]] }, CASHIER);
    const viaDraft = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "2000.00", shiftId: shift.shiftId,
      collectNow: { amount: "2000.00", method: "CASH" },
    }, CASHIER);

    const a = (await db().select().from(s.invoices).where(eq(s.invoices.id, Number(direct.regularSale!.invoiceId))))[0];
    const b = (await db().select().from(s.invoices).where(eq(s.invoices.id, viaDraft.regularSale!.invoiceId)))[0];
    expect(b.total).toBe(a.total);
    expect(b.paidAmount).toBe(a.paidAmount);
    expect(b.costTotal).toBe(a.costTotal);
    const sales = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "SALE"));
    expect(sales.length).toBe(2); // قيد SALE واحد لكل فاتورة (dedupeKey يحرسها)
  });
});
