/**
 * ═══ محرّك العكس **المنفِّذ** على فاتورة بيعٍ حقيقيّة (م٢ ق٧) ═══
 *
 * الثابتُ المحروس: بعد إلغاءٍ يمرّ بـ`reverse()` تكون **الحقيقةُ** قد عادت (مخزون · دفتر · ذمّة
 * · كوبون) **وسجلُّ الأثر** متوازناً (Σ كلّ نوعٍ = 0 في نطاق `sale`) — الاثنان معاً، لا صفوفُ
 * مرآةٍ بلا تعويض (Codex LC06).
 *
 * حالاتٌ ثلاث لا يكفي واحدةٌ منها:
 *  ① بيعٌ نقديّ بكوبون ⇒ إلغاءٌ بنقرة: المخزون والقيد والمدفوع يعودون، **والكوبون يُحرَّر** (D8).
 *  ② ردٌّ مؤجَّل (TRANSFER): المالُ لم يخرج ⇒ `PAID_AMOUNT` يُترك مفتوحاً **بإعلان**، والعميلُ
 *    دائنٌ بأثرٍ مفتوحٍ مُسجَّل — لا Σ=0 كاذب على مالٍ لم يُصرَف.
 *  ③ مرتجعٌ جزئيٌّ تالفٌ يدويّ ثمّ إلغاء: المُجسِّد يُصالح السجلَّ مع الحقيقة (ابنُ فرقٍ) فلا
 *    يُعاد التالفُ إلى الرفّ ولا تُعكَس كلفتُه مرّتين.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { cancelSale } from "../sale/cancel";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";
import { hashCouponCode, loadIssuedCouponDetails } from "../couponService";
import { createPromotion } from "../salesPromotionService";
import { approveVoucher } from "../voucher/approval";
import { withTx } from "../tx";
import { reverse, summarizeEffects } from "../reversalEngine";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const manager = { userId: 2, branchId: 1, role: "manager" as const };
const owner = { userId: 3, branchId: 1, role: "admin" as const }; // مالكٌ نشطٌ يعتمد السندات (≠ المُنشئ).

const TABLES = [
  "documentEffects", "idempotencyKeys", "couponRedemptions", "coupons", "couponPrograms",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItemBundleComponents", "invoiceItems", "invoices",
  "promotionTargets", "promotions", "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "categories", "shifts", "customers", "users", "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "mgr", name: "manager", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "owner", name: "owner", role: "admin", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
  ]);
  await d.insert(s.categories).values({ id: 1, name: "قرطاسية" });
  await d.insert(s.products).values({ id: 1, name: "دفتر", categoryId: 1 });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NB-1", costPrice: "400.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
  await d.insert(s.shifts).values({ id: 1, userId: 2, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "2:1", openingBalance: "0" });
  await d.insert(s.receipts).values({
    branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "10000000.00", paymentMethod: "CASH",
    status: "COMPLETED", referenceNumber: "TEST-TREASURY-FUND", createdBy: 1,
  });
}

async function couponFixture(code: string) {
  const promotionId = await withTx((tx) => createPromotion(tx, {
    name: "كوبون 10%", type: "PERCENT", discountPercent: "10", scope: "ALL",
    effectiveFrom: "2026-01-01", effectiveTo: "2027-01-01", branchId: 1, applicationMode: "COUPON",
  }, 1));
  const result = await db().insert(s.couponPrograms).values({
    promotionId, name: "برنامج اختباري", status: "ACTIVE", branchId: 1,
    validFrom: new Date("2026-01-01"), validTo: new Date("2027-01-01"), perCouponLimit: 1, perCustomerLimit: 1,
    codePrefix: "CRM", createdBy: 1,
  });
  const programId = Number((result as unknown as [{ insertId: number }])[0]?.insertId ?? (result as unknown as { insertId: number }).insertId);
  await db().insert(s.coupons).values({ programId, code, codeHash: hashCouponCode(code), status: "ACTIVE" });
  return { promotionId, code, programId };
}

async function stockOf(variantId: number, branchId: number): Promise<number> {
  const row = (await db().select({ q: s.branchStock.quantity }).from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId))).limit(1))[0];
  return Number(row?.q ?? 0);
}

async function sumCol(invoiceId: number, col: "revenue" | "cost" | "profit" | "amount"): Promise<string> {
  const rows = await db().select({ v: s.accountingEntries[col] }).from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId, invoiceId));
  return rows.reduce((t, r) => t.plus(money(r.v)), money(0)).toFixed(2);
}

/** Σ لكلّ نوعٍ داخل نطاق `sale` — يجب أن يكون صفراً للأنواع المعكوسة كاملاً. */
async function effectSums(invoiceId: number, scope = "sale"): Promise<Record<string, { amount: string; quantity: number; rows: number }>> {
  const rows = await db()
    .select({
      kind: s.documentEffects.effectKind,
      amount: sql<string>`SUM(${s.documentEffects.signedAmount})`,
      quantity: sql<number>`SUM(${s.documentEffects.signedQuantity})`,
      rows: sql<number>`COUNT(*)`,
    })
    .from(s.documentEffects)
    .where(and(eq(s.documentEffects.documentType, "INVOICE"), eq(s.documentEffects.documentId, invoiceId), eq(s.documentEffects.scope, scope)))
    .groupBy(s.documentEffects.effectKind);
  const out: Record<string, { amount: string; quantity: number; rows: number }> = {};
  for (const r of rows) out[r.kind] = { amount: money(r.amount ?? 0).toFixed(4), quantity: Number(r.quantity ?? 0), rows: Number(r.rows ?? 0) };
  return out;
}

async function customerBalance(customerId: number): Promise<string> {
  const row = (await db().select({ b: s.customers.currentBalance }).from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
  return money(row?.b ?? "0").toFixed(2);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("reverse() منفِّذاً — إلغاءُ فاتورةٍ بكوبون بنقرةٍ واحدة", () => {
  it("① المخزون والقيد والمدفوع والذمّة تعود، الكوبون يُحرَّر، وΣ كلّ نوعٍ = 0", async () => {
    const fx = await couponFixture("CRM-REV-1");
    const sale = await createSale(
      {
        branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1, priceTier: "RETAIL", couponCode: fx.code,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "1000.00", discountAmount: "200.00", promotionId: fx.promotionId }],
        payment: { amount: "1800.00", method: "CASH" },
      },
      manager,
    );
    expect(await stockOf(1, 1)).toBe(8);
    const couponBefore = (await db().select().from(s.coupons).where(eq(s.coupons.codeHash, hashCouponCode(fx.code))))[0]!;
    expect(couponBefore.status).toBe("REDEEMED");
    expect(couponBefore.redemptionCount).toBe(1);

    const res = await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "خطأ إدخال" }, admin);
    expect(res.refundAmount).toBe("1800.00");
    expect(res.pendingRefundAmount).toBe("0.00");

    // الحقيقةُ عادت.
    expect(await stockOf(1, 1)).toBe(10);
    expect(await sumCol(sale.invoiceId, "revenue")).toBe("0.00");
    expect(await sumCol(sale.invoiceId, "cost")).toBe("0.00");
    expect(await sumCol(sale.invoiceId, "profit")).toBe("0.00");
    expect(await customerBalance(1)).toBe("0.00");
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0]!;
    expect(inv.status).toBe("CANCELLED");
    expect(inv.paidAmount).toBe("0.00");
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    expect(items.every((i) => i.returnedBaseQuantity === i.baseQuantity && i.returnedRestockedBaseQuantity === i.baseQuantity)).toBe(true);

    // الكوبون حُرّر (D8): العدّاد عاد صفراً، الحالة ACTIVE، وصفّ الاسترداد زال (حدّ العميل يُعدّ بالصفوف).
    const couponAfter = (await db().select().from(s.coupons).where(eq(s.coupons.id, Number(couponBefore.id))))[0]!;
    expect(couponAfter.status).toBe("ACTIVE");
    expect(couponAfter.redemptionCount).toBe(0);
    expect(await db().select().from(s.couponRedemptions).where(eq(s.couponRedemptions.invoiceId, sale.invoiceId))).toHaveLength(0);

    // سجلُّ الأثر متوازنٌ نوعاً نوعاً، وكلُّ نوعٍ له APPLY وREVERSE فعليّان.
    const sums = await effectSums(sale.invoiceId);
    for (const kind of ["INVENTORY", "LEDGER_ENTRY", "PAID_AMOUNT", "COUPON"]) {
      expect(sums[kind], kind).toBeDefined();
      expect(sums[kind]!.amount, `${kind} amount`).toBe("0.0000");
      expect(sums[kind]!.quantity, `${kind} quantity`).toBe(0);
      expect(sums[kind]!.rows, `${kind} rows`).toBeGreaterThanOrEqual(2);
    }
    // فاتورةٌ مسدَّدة كاملاً ⇒ مساهمتُها في الذمّة صفر ⇒ لا أثرَ ذمّةٍ يُمثَّل أصلاً (لا صفٌّ صفريّ).
    expect(sums.CUSTOMER_BALANCE).toBeUndefined();
    // صفُّ REVERSE للردّ يشير إلى إيصال الصرف الحقيقيّ لا إلى رقمٍ منفصل.
    const refundReverse = (await db().select().from(s.documentEffects).where(and(
      eq(s.documentEffects.documentId, sale.invoiceId), eq(s.documentEffects.effectKind, "PAID_AMOUNT"), eq(s.documentEffects.phase, "REVERSE"),
    )))[0]!;
    expect(refundReverse.effectTable).toBe("receipts");
    const outReceipt = (await db().select().from(s.receipts).where(and(eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "OUT"))))[0]!;
    expect(Number(refundReverse.effectRowId)).toBe(Number(outReceipt.id));
    // والمحرّك idempotent: عكسٌ ثانٍ يجد صفرَ متبقٍّ.
    const again = await withTx((tx) => reverse(tx, "INVOICE", sale.invoiceId, { kind: "ALL", operationScopes: ["sale"] }, "ثانية", admin));
    expect(again.reversedCount).toBe(0);
    const summary = await withTx((tx) => summarizeEffects(tx, "INVOICE", sale.invoiceId));
    expect(summary.some((r) => r.effectKind === "COUPON" && r.phase === "REVERSE")).toBe(true);
  });

  it("② ردٌّ مؤجَّل (TRANSFER): PAID_AMOUNT يبقى مفتوحاً بإعلان، والعميل دائنٌ بأثرٍ مفتوحٍ مُسجَّل", async () => {
    const sale = await createSale(
      {
        branchId: 1, customerId: 1, sourceType: "ORDER",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
      },
      admin,
    );
    await db().update(s.invoices).set({ paidAmount: "2000.00", status: "PAID" }).where(eq(s.invoices.id, sale.invoiceId));
    await db().insert(s.receipts).values({
      invoiceId: sale.invoiceId, branchId: 1, direction: "IN", amount: "2000.00", paymentMethod: "TRANSFER",
      status: "COMPLETED", createdBy: 1,
    });
    await db().update(s.customers).set({ currentBalance: "0.00" }).where(eq(s.customers.id, 1));

    const res = await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin);
    expect(res.refundAmount).toBe("0.00");
    expect(res.pendingRefundAmount).toBe("2000.00");
    expect(res.refundVoucherNumber).toMatch(/^PV-/);

    // المالُ لم يخرج ⇒ المدفوع لم يُنقَص، والعميل دائنٌ بالمبلغ حتى اعتماد السند.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0]!;
    expect(inv.paidAmount).toBe("2000.00");
    expect(await customerBalance(1)).toBe("-2000.00");

    const sale_ = await effectSums(sale.invoiceId, "sale");
    expect(sale_.PAID_AMOUNT!.amount).toBe("2000.0000"); // مفتوحٌ بقصدٍ معلن — لا صفّ REVERSE
    expect(sale_.PAID_AMOUNT!.rows).toBe(1);
    expect(sale_.LEDGER_ENTRY!.amount).toBe("0.0000");
    expect(sale_.INVENTORY!.quantity).toBe(0);
    expect(sale_.CUSTOMER_BALANCE).toBeUndefined();
    const pendingCredit = await effectSums(sale.invoiceId, "refund-pending");
    expect(pendingCredit.CUSTOMER_BALANCE!.amount).toBe("-2000.0000");
    expect(await stockOf(1, 1)).toBe(10);
  });

  it("③ مرتجعٌ جزئيّ تالفٌ يدويّ ثمّ إلغاء: المُجسِّد يُصالح السجلّ فلا يُعاد التالف ولا تُعكَس كلفته", async () => {
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }] },
      admin,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0]!;
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }], refund: null, restock: false },
      admin,
    );
    expect(await stockOf(1, 1)).toBe(5);

    await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin);
    // ٣ فقط تعود (التالفتان لا) — والكلفة: الوحدتان التالفتان تبقيان خسارةً.
    expect(await stockOf(1, 1)).toBe(8);
    const finalItem = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.id, Number(item.id))))[0]!;
    expect(finalItem.returnedBaseQuantity).toBe(5);
    expect(finalItem.returnedRestockedBaseQuantity).toBe(3);
    expect(await sumCol(sale.invoiceId, "revenue")).toBe("0.00");
    expect(await sumCol(sale.invoiceId, "cost")).toBe("800.00"); // ٢ × ٤٠٠ خسارةُ التالف
    expect(await customerBalance(1)).toBe("0.00");

    // المُجسِّد كتب ابنَ فرقٍ (reconciled) للمخزون والقيد بمقدار المرتجع اليدويّ، ثمّ Σ = 0.
    const sums = await effectSums(sale.invoiceId);
    expect(sums.INVENTORY!.quantity).toBe(0);
    expect(sums.LEDGER_ENTRY!.amount).toBe("0.0000");
    const reconciled = await db().select().from(s.documentEffects).where(and(
      eq(s.documentEffects.documentId, sale.invoiceId), eq(s.documentEffects.phase, "REVERSE"),
      sql`JSON_EXTRACT(${s.documentEffects.payloadJson}, '$.reconciled') = true`,
    ));
    expect(reconciled.length).toBeGreaterThanOrEqual(2);
  });

  it("④ مرتجعٌ كامل (returnService) لعميلٍ مسجَّل بردٍّ جزئيّ: نفس المحرّك، والباقي رصيدٌ دائن بأثرٍ مُسمّى", async () => {
    const sale = await createSale(
      {
        branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
        payment: { amount: "2000.00", method: "CASH" },
      },
      manager,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0]!;
    const res = await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }],
        refund: { amount: "1500.00", method: "CASH", shiftId: 1 },
        restock: true,
        operatorReason: "عيب في المنتج",
      },
      admin,
    );
    expect(res.fullyReturned).toBe(true);
    expect(res.returnedTotal).toBe("2000.00");
    expect(await stockOf(1, 1)).toBe(10);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0]!;
    expect(inv.status).toBe("RETURNED");
    expect(inv.returnedTotal).toBe("2000.00");
    expect(inv.paidAmount).toBe("500.00"); // ٥٠٠ لم تُردّ بعد
    expect(await customerBalance(1)).toBe("-500.00"); // فصارت رصيداً دائناً مُسمّى
    expect(await sumCol(sale.invoiceId, "revenue")).toBe("0.00");
    expect(await sumCol(sale.invoiceId, "cost")).toBe("0.00");
    const ret = (await db().select().from(s.accountingEntries).where(and(eq(s.accountingEntries.invoiceId, sale.invoiceId), eq(s.accountingEntries.entryType, "RETURN"))))[0]!;
    expect(ret.notes).toContain("سبب المرتجع=عيب في المنتج");
    expect(ret.notes).toContain("مصير البضاعة=إعادة للرف");
    const sums = await effectSums(sale.invoiceId);
    expect(sums.INVENTORY!.quantity).toBe(0);
    expect(sums.LEDGER_ENTRY!.amount).toBe("0.0000");
    expect(sums.PAID_AMOUNT!.amount).toBe("500.0000"); // جزئيٌّ بإعلان
    const credit = await effectSums(sale.invoiceId, "credit");
    expect(credit.CUSTOMER_BALANCE!.amount).toBe("-500.0000");
  });

  it("⑤ مرتجعٌ كامل لبيعٍ نقديّ مقرَّب IQD (زبون عابر): Σ(revenue)=Σ(profit)=Σ(amount)=0 والتقريب يُعكَس مرّة", async () => {
    await db().update(s.productPrices).set({ price: "1300.00" }).where(eq(s.productPrices.productUnitId, 1));
    const sale = await createSale(
      {
        branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "1300.00", method: "CASH" }, cashRoundIQD: true,
      },
      manager,
    );
    const inv0 = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0]!;
    expect(inv0.total).toBe("1250.00");
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0]!;
    const res = await returnSale(
      {
        invoiceId: sale.invoiceId,
        lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
        resolution: { kind: "IMMEDIATE_REFUND", method: "CASH", amount: "1250.00", shiftId: 1, reason: "زبون عابر اعاد الطلب كله", disposition: "RESTOCK" },
      },
      admin,
    );
    expect(res.fullyReturned).toBe(true);
    expect(res.returnedTotal).toBe("1250.00");
    expect(await sumCol(sale.invoiceId, "revenue")).toBe("0.00");
    expect(await sumCol(sale.invoiceId, "profit")).toBe("0.00");
    // ⭐ Σ(amount) على قيود البيع/المرتجع/التقريب = 0 — كان المسار القديم يترك −50 (فارق التقريب).
    const nonCash = await db().select().from(s.accountingEntries).where(and(
      eq(s.accountingEntries.invoiceId, sale.invoiceId),
      inArray(s.accountingEntries.entryType, ["SALE", "RETURN", "ADJUST"]),
    ));
    expect(nonCash.reduce((t, e) => t.plus(money(e.amount)), money(0)).toFixed(2)).toBe("0.00");
    expect(nonCash.filter((e) => e.entryType === "ADJUST")).toHaveLength(2);
    const sums = await effectSums(sale.invoiceId);
    expect(sums.ROUNDING!.amount).toBe("0.0000");
    expect(sums.PAID_AMOUNT!.amount).toBe("0.0000");
    const out = (await db().select().from(s.receipts).where(and(eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "OUT"))))[0]!;
    expect(out.amount).toBe("1250.00");
    // وصفُ إيصال الردّ يحمل سببَ الزبون العابر (descriptionNote) — لا نصَّ الإلغاء.
    expect(out.description).toContain("زبون عابر اعاد الطلب كله");
  });

  it("نوعٌ بلا منفّذ في وضع التنفيذ يرمي NOT_IMPLEMENTED صراحةً — لا مرآة صامتة", async () => {
    await withTx(async (tx) => {
      const { recordEffect } = await import("../reversalEngine");
      await recordEffect(tx, { documentType: "INVOICE", documentId: 424242, effectKind: "COMMISSION", signedAmount: "50.00", branchId: 1 }, admin);
    });
    await expect(
      withTx((tx) => reverse(tx, "INVOICE", 424242, { kind: "ALL" }, "عكس بلا منفّذ", admin)),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("⑥ صفوفُ REVERSE للقيود تشير إلى القيد المعوِّض (RETURN/ADJUST) لا إلى قيد SALE الأصليّ (Codex P2)", async () => {
    await db().update(s.productPrices).set({ price: "1300.00" }).where(eq(s.productPrices.productUnitId, 1));
    const sale = await createSale(
      {
        branchId: 1, shiftId: 1, priceTier: "RETAIL", sourceType: "POS", customerId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "1300.00", method: "CASH" }, cashRoundIQD: true,
      },
      manager,
    );
    await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "خطأ إدخال" }, admin);

    const allEntries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId, sale.invoiceId));
    const saleEntry = allEntries.find((e) => e.entryType === "SALE")!;
    const returnEntry = allEntries.find((e) => e.entryType === "RETURN")!;
    const adjustReversal = allEntries.find((e) => e.entryType === "ADJUST" && e.dedupeKey === `ADJUST:IQD:CANCEL:${sale.invoiceId}`)!;
    expect(returnEntry).toBeDefined();
    expect(adjustReversal).toBeDefined();

    // صفُّ REVERSE لقيد البيع يشير إلى قيد RETURN المُدرَج — لا إلى قيد SALE الأصليّ.
    const ledgerReverse = (await db().select().from(s.documentEffects).where(and(
      eq(s.documentEffects.documentId, sale.invoiceId), eq(s.documentEffects.effectKind, "LEDGER_ENTRY"), eq(s.documentEffects.phase, "REVERSE"),
    )))[0]!;
    expect(ledgerReverse.effectTable).toBe("accountingEntries");
    expect(Number(ledgerReverse.effectRowId)).toBe(Number(returnEntry.id));
    expect(Number(ledgerReverse.effectRowId)).not.toBe(Number(saleEntry.id));

    // وصفُّ REVERSE للتقريب يشير إلى قيد ADJUST العكسيّ المُدرَج.
    const roundingReverse = (await db().select().from(s.documentEffects).where(and(
      eq(s.documentEffects.documentId, sale.invoiceId), eq(s.documentEffects.effectKind, "ROUNDING"), eq(s.documentEffects.phase, "REVERSE"),
    )))[0]!;
    expect(Number(roundingReverse.effectRowId)).toBe(Number(adjustReversal.id));
  });

  it("⑦ مرتجعٌ جزئيّ مُعادٌ للمخزون ثمّ إلغاء: لا كمّيةَ مخزونٍ وهميّة (الملخّص بلا نطاق متوازن) (Codex P2)", async () => {
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }] },
      admin,
    );
    const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0]!;
    await returnSale(
      { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 2 }], refund: null, restock: true },
      admin,
    );
    expect(await stockOf(1, 1)).toBe(7); // بيعُ ٥ ⇒ ٥، وإعادةُ ٢ للرفّ ⇒ ٧.

    await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH" }, admin);
    expect(await stockOf(1, 1)).toBe(10); // الباقي (٣) يعود ⇒ خطُّ الأساس.

    // الملخّصُ بلا نطاق: مجموعُ كمّية INVENTORY = 0 — لا +٢ وهميّةٌ من كاتبٍ ظلّيٍّ بنطاق "return".
    const summary = await withTx((tx) => summarizeEffects(tx, "INVOICE", sale.invoiceId));
    const invQty = summary.filter((r) => r.effectKind === "INVENTORY").reduce((t, r) => t + r.sumQuantity, 0);
    expect(invQty).toBe(0);
    // وكلُّ آثار المخزون في نطاق البيع وحده (لا نطاق "return" منتِجٌ للوهم).
    const invScopes = await db().select({ scope: s.documentEffects.scope }).from(s.documentEffects).where(and(
      eq(s.documentEffects.documentId, sale.invoiceId), eq(s.documentEffects.effectKind, "INVENTORY")));
    expect(new Set(invScopes.map((r) => r.scope))).toEqual(new Set(["sale"]));
  });

  it("⑧ ردٌّ مؤجَّل (TRANSFER) يُغلَق أثراه عند اعتماد السند: PAID_AMOUNT وrefund-pending إلى Σ=0 (Codex P2)", async () => {
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }] },
      admin,
    );
    await db().update(s.invoices).set({ paidAmount: "2000.00", status: "PAID" }).where(eq(s.invoices.id, sale.invoiceId));
    await db().insert(s.receipts).values({
      invoiceId: sale.invoiceId, branchId: 1, direction: "IN", amount: "2000.00", paymentMethod: "TRANSFER",
      status: "COMPLETED", createdBy: 1,
    });
    await db().update(s.customers).set({ currentBalance: "0.00" }).where(eq(s.customers.id, 1));

    const res = await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "TRANSFER" }, admin);
    expect(res.pendingRefundAmount).toBe("2000.00");
    // قبل الاعتماد: الأثران مفتوحان بقصد.
    const before = await effectSums(sale.invoiceId, "sale");
    expect(before.PAID_AMOUNT!.amount).toBe("2000.0000");
    const beforePending = await effectSums(sale.invoiceId, "refund-pending");
    expect(beforePending.CUSTOMER_BALANCE!.amount).toBe("-2000.0000");

    const pendingReceipt = (await db().select().from(s.receipts).where(and(
      eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "OUT"), eq(s.receipts.approvalStatus, "PENDING_APPROVAL"),
    )))[0]!;
    await approveVoucher(Number(pendingReceipt.id), owner); // مُعتمِدٌ مالكٌ نشط ≠ مُنشئ (SOD).

    // المالُ خرج ⇒ الأثران أُغلقا: Σ كلٍّ منهما صفر، وصفُّ REVERSE يشير إلى إيصال الصرف.
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0]!;
    expect(inv.paidAmount).toBe("0.00");
    expect(await customerBalance(1)).toBe("0.00");
    const afterSale = await effectSums(sale.invoiceId, "sale");
    expect(afterSale.PAID_AMOUNT!.amount).toBe("0.0000");
    expect(afterSale.PAID_AMOUNT!.rows).toBeGreaterThanOrEqual(2);
    const afterPending = await effectSums(sale.invoiceId, "refund-pending");
    expect(afterPending.CUSTOMER_BALANCE!.amount).toBe("0.0000");
    const paidReverse = (await db().select().from(s.documentEffects).where(and(
      eq(s.documentEffects.documentId, sale.invoiceId), eq(s.documentEffects.effectKind, "PAID_AMOUNT"), eq(s.documentEffects.phase, "REVERSE"),
    )))[0]!;
    expect(paidReverse.effectTable).toBe("receipts");
    expect(Number(paidReverse.effectRowId)).toBe(Number(pendingReceipt.id));
  });

  it("⑨ إلغاءُ بيعٍ بكوبون يحفظ تاريخَ الاستبدال في تفاصيل الكوبون رغم تحرّره (Codex P2)", async () => {
    const fx = await couponFixture("CRM-REV-9");
    const sale = await createSale(
      {
        branchId: 1, shiftId: 1, sourceType: "POS", customerId: 1, priceTier: "RETAIL", couponCode: fx.code,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "1000.00", discountAmount: "200.00", promotionId: fx.promotionId }],
        payment: { amount: "1800.00", method: "CASH" },
      },
      manager,
    );
    const coupon = (await db().select().from(s.coupons).where(eq(s.coupons.codeHash, hashCouponCode(fx.code))))[0]!;
    await cancelSale({ invoiceId: sale.invoiceId, refundPaymentMethod: "CASH", reason: "خطأ إدخال" }, admin);

    // صفُّ الاسترداد حُذف (الكوبون تحرّر لعميله) — لا يُعدُّ في الأهليّة.
    expect(await db().select().from(s.couponRedemptions).where(eq(s.couponRedemptions.invoiceId, sale.invoiceId))).toHaveLength(0);
    // لكنّ تفاصيل الكوبون تُظهر الاستبدال الملغى من سجلّ الأثر — لا «لم يُستبدَل قطّ».
    const details = await withTx((tx) => loadIssuedCouponDetails(tx, [{ id: Number(coupon.id), customerId: 1 }]));
    const d = details.get(Number(coupon.id))!;
    expect(d.reversedRedemptionCount).toBe(1);
    expect(d.lastReversedInvoiceId).toBe(sale.invoiceId);
    expect(d.lastReversedInvoiceStatus).toBe("CANCELLED");
    expect(d.lastReversedRedeemedAt).not.toBeNull();
    expect(d.lastInvoiceNumber).toBeNull(); // لا استبدالٌ حيّ.
  });
});
