// اختبارات رقيب الشذوذ — الكواشف الستة الحتمية على بيانات مبنية بنداءات الخدمات الحقيقية
// (createSale/returnSale/createVoucher/cancelVoucher) لا بإدراج خام، إلا حيث يحاكي الاختبار
// عمداً ما لا يفعله التطبيق (حذف صف فاتورة مباشرة لاختبار كاشف العبث D6، وسطر سجلّ تدقيق
// return.create لأن logAudit يستدعيه الراوتر لا الخدمة).
import { eq, sql, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createSale } from "../saleService";
import { returnSale } from "../returnService";
import { createVoucher } from "../voucher/create";
import { cancelVoucher } from "../voucher/cancel";
import { getAnomalyWatch } from "../reports/anomalyWatch";

const actor1 = { userId: 1, branchId: 1 }; // أدمن
const actor2 = { userId: 2, branchId: 1 }; // مدير
const actor2b2 = { userId: 2, branchId: 2 };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "users",
  "auditLogs",
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
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_mgr", name: "منال", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_cashier", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "120.00" },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل آجل", defaultPriceTier: "RETAIL", currentBalance: "0" });
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

/** YYYY-MM-DD محلي (نمط dateRange — لا toISOString). */
function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const TODAY = () => localYmd(new Date());

/** بيع آجل (بلا نقد ⇒ لا وردية لازمة). */
async function creditSale(
  actor: { userId: number; branchId: number },
  line: { productUnitId: number; quantity: string; unitPriceOverride?: string; discountAmount?: string },
  opts?: { priceOverrideApproved?: boolean },
) {
  return createSale(
    {
      branchId: actor.branchId,
      customerId: 1,
      sourceType: "ORDER",
      lines: [{ variantId: 1, ...line }],
      ...(opts?.priceOverrideApproved ? { priceOverrideApproved: true } : {}),
    } as any,
    actor,
  );
}

function makeCtx(user: any = null) {
  const res = { cookie() {}, clearCookie() {} };
  const req = { headers: {} as Record<string, string> };
  return { req, res, user } as any;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("D1 — بيع دون الكلفة", () => {
  it("سطر بسعر تجاوزٍ تحت الكلفة يُكتشف بخسارته الدقيقة، والبيع السليم لا يظهر", async () => {
    await setStock(1, 1, 100);
    // الكاشير 1: قطعتان بسعر 3.00 والكلفة 4.00 ⇒ خسارة (2×4 − 6) = 2.00
    await creditSale(actor1, { productUnitId: 1, quantity: "2", unitPriceOverride: "3.00" }, { priceOverrideApproved: true });
    // الكاشير 2: بيع سليم بسعر القائمة
    await creditSale(actor2, { productUnitId: 1, quantity: "2" });

    const aw = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    expect(aw.kpis.belowCostLines).toBe(1);
    expect(aw.kpis.belowCostLoss).toBe("2.00");
    expect(aw.belowCost.cashiers).toHaveLength(1);
    expect(aw.belowCost.cashiers[0].userId).toBe(1);
    expect(aw.belowCost.cashiers[0].userName).toBe("المدير");
    expect(aw.belowCost.cashiers[0].lineCount).toBe(1);
    expect(aw.belowCost.cashiers[0].lossValue).toBe("2.00");
    expect(aw.belowCost.worstLines).toHaveLength(1);
    expect(aw.belowCost.worstLines[0].productName).toBe("قلم");
    expect(aw.belowCost.worstLines[0].lineTotal).toBe("6.00");
    expect(aw.belowCost.worstLines[0].lineCost).toBe("8.00");
    expect(aw.belowCost.worstLines[0].lossValue).toBe("2.00");
  });
});

describe("D2 — طفرة الخصومات لكل كاشير", () => {
  it("كاشير بنسبة خصم 10% مقابل نطاقٍ متوسطه 1% يُعلَّم، والآخر لا", async () => {
    await setStock(1, 1, 2000);
    // الكاشير 1: إجمالي 100 وخصم يدوي 10 ⇒ 10%
    await creditSale(actor1, { productUnitId: 1, quantity: "10", discountAmount: "10.00" });
    // الكاشير 2: إجمالي 900 بلا خصم ⇒ 0% — متوسط النطاق = 10/1000 = 1% ⇒ العتبة max(2%, 5%) = 5%
    await creditSale(actor2, { productUnitId: 1, quantity: "90" });

    const aw = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    expect(aw.discounts.scopeAvgRatePct).toBe("1.00");
    expect(aw.kpis.flaggedDiscountCashiers).toBe(1);
    const r1 = aw.discounts.rows.find((r) => r.userId === 1)!;
    const r2 = aw.discounts.rows.find((r) => r.userId === 2)!;
    expect(r1.grossTotal).toBe("100.00");
    expect(r1.manualDiscount).toBe("10.00");
    expect(r1.discountRatePct).toBe("10.00");
    expect(r1.promoDiscount).toBe("0.00");
    expect(r1.flagged).toBe(true);
    expect(r2.manualDiscount).toBe("0.00");
    expect(r2.flagged).toBe(false);
  });
});

describe("D3 — تركّز المرتجعات", () => {
  it("النسبة تُحسب على بائع الفاتورة الأصلية، ومعالج الإرجاع يظهر من سجلّ التدقيق", async () => {
    await setStock(1, 1, 100);
    // البائع 1: درزنان = 240، يُرجَع درزن (120) ⇒ 50%
    const sale1 = await creditSale(actor1, { productUnitId: 2, quantity: "2" });
    // البائع 2: درزنان = 240 بلا مرتجع — متوسط النطاق = 120/480 = 25% ⇒ العتبة 50%
    await creditSale(actor2, { productUnitId: 2, quantity: "2" });

    const item = (
      await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale1.invoiceId))
    )[0];
    await returnSale(
      { invoiceId: sale1.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: 12 }], restock: true },
      actor2,
    );
    // logAudit يستدعيه returnRouter لا الخدمة ⇒ نحاكي سطر الراوتر (معالج الإرجاع = المستخدم 2).
    await db().insert(s.auditLogs).values({
      userId: 2, branchId: 1, action: "return.create", entityType: "invoice", entityId: String(sale1.invoiceId),
    });

    const aw = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    const seller1 = aw.returns.sellers.find((r) => r.userId === 1)!;
    const seller2 = aw.returns.sellers.find((r) => r.userId === 2)!;
    expect(seller1.salesTotal).toBe("240.00");
    expect(seller1.returnedTotal).toBe("120.00");
    expect(seller1.returnRatePct).toBe("50.00");
    expect(seller1.flagged).toBe(true);
    expect(seller2.returnedTotal).toBe("0.00");
    expect(seller2.flagged).toBe(false);
    expect(aw.kpis.flaggedReturnSellers).toBe(1);
    expect(aw.returns.processors).toHaveLength(1);
    expect(aw.returns.processors[0].userId).toBe(2);
    expect(aw.returns.processors[0].opsCount).toBe(1);
  });
});

describe("D4 — عجوزات الورديات", () => {
  it("ورديتا عجز تُعلَّمان، ووردية عجز واحدة صغيرة لا", async () => {
    const now = new Date();
    await db().insert(s.shifts).values([
      { branchId: 1, userId: 1, status: "CLOSED", openedAt: now, closedAt: now, openingBalance: "0", variance: "-5000.00" },
      { branchId: 1, userId: 1, status: "CLOSED", openedAt: now, closedAt: now, openingBalance: "0", variance: "-5000.00" },
      { branchId: 1, userId: 2, status: "CLOSED", openedAt: now, closedAt: now, openingBalance: "0", variance: "-3000.00" },
      // وردية مفتوحة لا تدخل الحساب
      { branchId: 1, userId: 2, status: "OPEN", openedAt: now, openingBalance: "0", openGuard: "2:1:RETAIL" },
    ]);

    const aw = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    const u1 = aw.shiftShortages.rows.find((r) => r.userId === 1)!;
    const u2 = aw.shiftShortages.rows.find((r) => r.userId === 2)!;
    expect(u1.shortageShifts).toBe(2);
    expect(u1.totalShortage).toBe("10000.00");
    expect(u1.flagged).toBe(true);
    expect(u2.shortageShifts).toBe(1);
    expect(u2.totalShortage).toBe("3000.00");
    expect(u2.flagged).toBe(false);
    expect(aw.kpis.flaggedShortageCashiers).toBe(1);
  });
});

describe("D5 — عكس السندات", () => {
  it("سند يُعكس يظهر بمنشئه وعاكسه، وعكسٌ واحد لا يُعلَّم", async () => {
    const v = await createVoucher(
      { voucherType: "PAYMENT", branchId: 1, amount: "50.00", paymentMethod: "CASH", partyType: "OTHER", description: "اختبار عكس" },
      { ...actor2, role: "manager" } as any,
    );
    await cancelVoucher(v.receiptId, { ...actor1, role: "admin" } as any);

    const aw = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    expect(aw.kpis.reversedVouchers).toBe(1);
    const row = aw.reversedVouchers.rows[0];
    expect(row.voucherNumber).toBe(v.voucherNumber);
    expect(row.direction).toBe("OUT");
    expect(row.amount).toBe("50.00");
    expect(row.createdByName).toBe("منال");
    expect(row.reversedByName).toBe("المدير");
    expect(row.flagged).toBe(false);
  });
});

describe("D6 — سلامة تسلسل الترقيم (كاشف عبث)", () => {
  it("لا فجوات في الوضع الطبيعي؛ حذف صفٍّ مباشرةً من القاعدة يكشف فجوة", async () => {
    await setStock(1, 1, 100);
    await creditSale(actor1, { productUnitId: 1, quantity: "1" });
    const mid = await creditSale(actor1, { productUnitId: 1, quantity: "1" });
    await creditSale(actor1, { productUnitId: 1, quantity: "1" });

    const before = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    expect(before.sequenceGaps.rows).toHaveLength(0);
    expect(before.kpis.sequenceGapDays).toBe(0);

    // عبث مقصود: حذف الفاتورة الوسطى مباشرة (مستحيل من التطبيق — لا مسار حذف للفواتير).
    const d = db();
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    await d.execute(sql`DELETE FROM invoiceItems WHERE invoiceId = ${mid.invoiceId}`);
    await d.execute(sql`DELETE FROM accountingEntries WHERE invoiceId = ${mid.invoiceId}`);
    await d.execute(sql`DELETE FROM invoices WHERE id = ${mid.invoiceId}`);
    await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    const after = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    expect(after.sequenceGaps.rows).toHaveLength(1);
    expect(after.sequenceGaps.rows[0].branchId).toBe(1);
    expect(after.sequenceGaps.rows[0].actualCount).toBe(2);
    expect(after.sequenceGaps.rows[0].maxSeq).toBe(3);
    expect(after.sequenceGaps.rows[0].missing).toBe(1);
    expect(after.kpis.sequenceGapDays).toBe(1);
  });
});

describe("عزل الفرع + RBAC", () => {
  it("فلتر الفرع في الخدمة يقصر النتائج على فرعه", async () => {
    await setStock(1, 1, 100);
    await setStock(1, 2, 100);
    await creditSale(actor1, { productUnitId: 1, quantity: "2", unitPriceOverride: "3.00" }, { priceOverrideApproved: true });
    await creditSale(actor2b2, { productUnitId: 1, quantity: "2", unitPriceOverride: "3.00" }, { priceOverrideApproved: true });

    const all = await getAnomalyWatch({ from: TODAY(), to: TODAY() });
    expect(all.belowCost.cashiers).toHaveLength(2);
    const b1 = await getAnomalyWatch({ from: TODAY(), to: TODAY(), branchId: 1 });
    expect(b1.belowCost.cashiers).toHaveLength(1);
    expect(b1.belowCost.cashiers[0].userId).toBe(1);
  });

  it("الكاشير مرفوض من النقطة، والمدير غير الأدمن يُقيَّد بفرعه حتى لو طلب فرعاً آخر", async () => {
    await setStock(1, 1, 100);
    await setStock(1, 2, 100);
    await creditSale(actor1, { productUnitId: 1, quantity: "2", unitPriceOverride: "3.00" }, { priceOverrideApproved: true });
    await creditSale(actor2b2, { productUnitId: 1, quantity: "2", unitPriceOverride: "3.00" }, { priceOverrideApproved: true });

    const cashier = (await db().select().from(s.users).where(eq(s.users.id, 3)))[0];
    const cashierCaller = appRouter.createCaller(makeCtx(cashier));
    await expect(cashierCaller.reports.anomalyWatch({ from: TODAY(), to: TODAY() })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // مدير فرعه 1 يطلب فرع 2 ⇒ تَرفضه بوابة عزل الفرع في reportViewerProcedure صراحةً (لا تقييد صامت)
    const mgr = (await db().select().from(s.users).where(eq(s.users.id, 2)))[0];
    const mgrCaller = appRouter.createCaller(makeCtx(mgr));
    await expect(mgrCaller.reports.anomalyWatch({ from: TODAY(), to: TODAY(), branchId: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // وبلا branchId صريح ⇒ يُقيَّد بفرعه عبر scopedBranchId فلا يرى إلا بيانات الفرع 1
    const scoped = await mgrCaller.reports.anomalyWatch({ from: TODAY(), to: TODAY() });
    expect(scoped.belowCost.cashiers).toHaveLength(1);
    expect(scoped.belowCost.cashiers[0].userId).toBe(1); // بيع الفرع 1 (بائعه المستخدم 1) لا بيع الفرع 2
  });
});
