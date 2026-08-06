import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import {
  dashboardService, finalizeService, intentService, offeringService,
  pricingService, providerService, walletOpsService, walletService,
} from "../digitalCards";

/**
 * البطاقات الرقمية — ش١١: الداشبورد.
 * معيار الخروج: **الأرقام تتطابق مع استعلامات تحقق مستقلة** — كل تأكيدٍ هنا يقارن
 * مخرَج الداشبورد باستعلام SQL مباشر يُحسب بطريقةٍ أخرى، لا بثابتٍ مكتوب يدوياً.
 */

const actor = { userId: 1, branchId: 1, role: "cashier" };
const mgr = { userId: 2, branchId: 1, role: "manager" };
const DATE = "2026-07-29";
const FROM = "2026-01-01";
const TO = "2027-01-01";

const TABLES = [
  "digitalWalletReconciliations", "digitalSaleDetails", "digitalSaleExecutionClaims", "digitalSaleIntentItems",
  "digitalWalletReservations", "digitalSaleIntents", "digitalWalletTransactions",
  "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWallets", "digitalProviders",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "shifts", "auditLogs", "studentProfiles", "customers", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }
const scope = (over: Partial<dashboardService.Scope> = {}): dashboardService.Scope =>
  ({ from: FROM, to: TO, branchId: 1, includeCost: true, ...over });

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "u1", name: "كاشير", role: "cashier", loginMethod: "local" },
    { id: 2, openId: "u2", name: "مدير", role: "manager", loginMethod: "local" },
  ]);
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0" });
}

async function mkProvider(name: string, mode: "PREPAID" | "POSTPAID") {
  const { supplierId } = await createSupplier({ name }, { userId: 1, branchId: 1 });
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode: mode, recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND", lowBalanceThreshold: "50000",
  }, { userId: 1, branchId: 1 }));
  return { providerId, supplierId };
}

async function mkWallet(providerId: number, balance: string, code = "W1") {
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(tx, { providerId, branchId: 1, code, name: `محفظة ${code}` }, { userId: 1, branchId: 1 }));
  await withTx((tx) => walletOpsService.deposit(tx, {
    walletId, amount: balance, paymentMethod: "CASH", clientRequestId: `dep-${code}-${Math.random().toString(36).slice(2, 9)}`,
  }, mgr));
  return walletId;
}

async function mkOffering(providerId: number, name: string, walletId: number | null, branchId = 1) {
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: "TELECOM_CARD", name, pricingMode: "FIXED_MARGIN",
    fixedMargin: "850", roundingStep: "0", branches: [{ branchId, walletId }],
  }, { userId: 1, branchId: 1 }));
  return r.offeringId;
}

async function publish(providerId: number, branchId: number, lines: { offeringId: number; providerShare: string }[]) {
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(tx, { branchId, providerId, businessDate: DATE }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.publish(tx, { batchId }, { userId: 1, branchId: 1 }));
  const rows = await db()
    .select({ offeringId: s.digitalCurrentPrices.offeringId, pv: s.digitalCurrentPrices.priceVersionId, price: s.digitalPriceVersions.sellPrice })
    .from(s.digitalCurrentPrices)
    .innerJoin(s.digitalPriceVersions, eq(s.digitalCurrentPrices.priceVersionId, s.digitalPriceVersions.id))
    .where(eq(s.digitalCurrentPrices.branchId, branchId));
  return new Map(rows.map((r) => [Number(r.offeringId), { pv: Number(r.pv), price: r.price }]));
}

let seq = 0;
async function sell(offerings: { offeringId: number; priced: { pv: number; price: string } }[]) {
  const id = ++seq;
  const r = await withTx((tx) => intentService.prepare(tx, {
    clientRequestId: `p-${id}-${Math.random().toString(36).slice(2, 9)}`, branchId: 1, shiftId: 1,
    paymentMethod: "CASH", cartFingerprint: `fp${id}`,
    lines: offerings.map((o, i) => ({
      lineKey: `lk-${id}-${i}`, offeringId: o.offeringId, priceVersionId: o.priced.pv, expectedSellPrice: o.priced.price,
    })),
  }, actor));
  const items = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, r.intentId));
  for (const it of items) {
    await withTx(async (tx) => {
      const claimToken = `dashboard-claim-${id}-${it.id}`;
      await intentService.claimExecution(tx, { intentId: r.intentId, intentItemId: Number(it.id), claimToken }, actor);
      return intentService.markExecution(tx, {
        intentId: r.intentId, intentItemId: Number(it.id), claimToken, status: "SUCCESS", providerReference: `R-${id}-${it.id}`,
      }, actor);
    });
  }
  const total = offerings.reduce((a, o) => a + Number(o.priced.price), 0);
  return withTx((tx) => finalizeService.finalize(tx, {
    intentId: r.intentId, clientRequestId: `f-${id}-${Math.random().toString(36).slice(2, 9)}`,
    paymentAmount: total.toFixed(2), paymentMethod: "CASH",
  }, actor));
}

/** استعلام تحقّق مستقل — يُحسب مباشرةً من التفاصيل بلا مرور بالداشبورد. */
async function verifySales() {
  const [row] = await db()
    .select({
      cards: sql<number>`COUNT(*)`,
      sales: sql<string>`COALESCE(SUM(${s.digitalSaleDetails.sellPriceSnapshot}),0)`,
      share: sql<string>`COALESCE(SUM(${s.digitalSaleDetails.providerShareSnapshot}),0)`,
      profit: sql<string>`COALESCE(SUM(${s.digitalSaleDetails.profitSnapshot}),0)`,
    })
    .from(s.digitalSaleDetails);
  return row;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
  seq = 0;
});

describe("ش١١ — معيار الخروج: تطابق الأرقام مع استعلامات مستقلة", () => {
  it("الملخّص يطابق الجمع المباشر من التفاصيل", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "كارت أ", walletId);
    const b = await mkOffering(pre.providerId, "كارت ب", walletId);
    const priced = await publish(pre.providerId, 1, [
      { offeringId: a, providerShare: "13400" }, { offeringId: b, providerShare: "4150" },
    ]);
    await sell([{ offeringId: a, priced: priced.get(a)! }]);
    await sell([{ offeringId: a, priced: priced.get(a)! }, { offeringId: b, priced: priced.get(b)! }]);

    const sum = await dashboardService.summary(db(), scope());
    const v = await verifySales();

    expect(sum.cards).toBe(Number(v.cards));
    expect(Number(sum.sales)).toBe(Number(v.sales));
    expect(Number(sum.providerShare)).toBe(Number(v.share));
    expect(Number(sum.profit)).toBe(Number(v.profit));
    // وثابت §٥.١٠ يصمد على مستوى الداشبورد أيضاً.
    expect(Number(sum.providerShare) + Number(sum.profit)).toBe(Number(sum.sales));
    expect(sum.invoices).toBe(2);
    expect(sum.cards).toBe(3);
  });

  it("التجميع بنمط التسوية يساوي الإجمالي", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const post = await mkProvider("منصّة", "POSTPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "كارت", walletId);
    const c = await mkOffering(post.providerId, "اشتراك", null);
    const pa = await publish(pre.providerId, 1, [{ offeringId: a, providerShare: "13400" }]);
    const pc = await publish(post.providerId, 1, [{ offeringId: c, providerShare: "80000" }]);
    await sell([{ offeringId: a, priced: pa.get(a)! }]);
    await sell([{ offeringId: c, priced: pc.get(c)! }]);

    const sum = await dashboardService.summary(db(), scope());
    const modeTotal = sum.byMode.reduce((acc, m) => acc + Number(m.sales), 0);
    expect(modeTotal).toBe(Number(sum.sales));
    expect(sum.byMode.map((m) => m.settlementMode).sort()).toEqual(["POSTPAID", "PREPAID"]);
  });

  it("الذمم الآجلة تطابق رصيد المورّد الفعليّ", async () => {
    const post = await mkProvider("منصّة", "POSTPAID");
    const c = await mkOffering(post.providerId, "اشتراك", null);
    const pc = await publish(post.providerId, 1, [{ offeringId: c, providerShare: "80000" }]);
    await sell([{ offeringId: c, priced: pc.get(c)! }]);
    await sell([{ offeringId: c, priced: pc.get(c)! }]);

    const dues = await dashboardService.postpaidDues(db());
    const [sup] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, post.supplierId));
    expect(Number(dues.totalDue)).toBe(Number(sup.currentBalance));
    expect(Number(dues.totalDue)).toBe(160000);
  });

  it("أرصدة المحافظ تطابق مجموع الأرصدة المخزَّنة", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    await mkWallet(pre.providerId, "300000", "W1");
    await mkWallet(pre.providerId, "40000", "W2");

    const pb = await dashboardService.providerBalances(db(), 1);
    const [agg] = await db().select({ t: sql<string>`COALESCE(SUM(${s.digitalWallets.currentBalance}),0)` }).from(s.digitalWallets);
    expect(Number(pb.totalAsset)).toBe(Number(agg.t));
    expect(pb.wallets).toHaveLength(2);
    // الحدّ ٥٠٬٠٠٠ ⇒ محفظة الـ٤٠٬٠٠٠ منخفضة والأخرى لا.
    expect(pb.wallets.filter((w) => w.isLow)).toHaveLength(1);
  });
});

describe("ش١١ — النطاق والفترة", () => {
  it("الفترة نصف مفتوحة: يومٌ واحد لا يبتلع اليوم التالي", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "كارت", walletId);
    const priced = await publish(pre.providerId, 1, [{ offeringId: a, providerShare: "13400" }]);
    const r = await sell([{ offeringId: a, priced: priced.get(a)! }]);

    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, r.invoiceId));
    const day = new Date(inv.createdAt).toISOString().slice(0, 10);
    const next = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

    // [day, next) يشمل البيع؛ [next, next+1) لا يشمله.
    expect((await dashboardService.summary(db(), scope({ from: day, to: next }))).cards).toBe(1);
    const after = new Date(new Date(`${next}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    expect((await dashboardService.summary(db(), scope({ from: next, to: after }))).cards).toBe(0);
  });

  it("عزل الفرع: مبيعات فرعٍ لا تظهر لفرعٍ آخر", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "كارت", walletId);
    const priced = await publish(pre.providerId, 1, [{ offeringId: a, providerShare: "13400" }]);
    await sell([{ offeringId: a, priced: priced.get(a)! }]);

    expect((await dashboardService.summary(db(), scope({ branchId: 1 }))).cards).toBe(1);
    expect((await dashboardService.summary(db(), scope({ branchId: 2 }))).cards).toBe(0);
    expect((await dashboardService.summary(db(), scope({ branchId: null }))).cards).toBe(1);
  });

  it("حجب التكلفة: includeCost=false يُصفّر الحصة والربح ويُبقي المبيعات", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "كارت", walletId);
    const priced = await publish(pre.providerId, 1, [{ offeringId: a, providerShare: "13400" }]);
    await sell([{ offeringId: a, priced: priced.get(a)! }]);

    const hidden = await dashboardService.summary(db(), scope({ includeCost: false }));
    expect(hidden.sales).toBe("14250.00");
    expect(hidden.providerShare).toBeNull();
    expect(hidden.profit).toBeNull();
    expect(hidden.byMode[0].profit).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain("13400");

    const top = await dashboardService.topOfferings(db(), scope({ includeCost: false }));
    expect(top[0].profit).toBeNull();
  });
});

describe("ش١١ — الصحة والحالات المعلّقة", () => {
  it("صحة الأسعار تُميّز READY عن NO_PRICE", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "مُسعَّرة", walletId);
    await publish(pre.providerId, 1, [{ offeringId: a, providerShare: "13400" }]);
    // البطاقة الجديدة تُنشأ **بعد** النشر — وهذا بالضبط ما يرصده هذا التقرير: بطاقةٌ أُضيفت
    // ولم تُسعَّر بعد. (النشر نفسه يرفض دفعةً ينقصها سعر — حارس ش٤.)
    await mkOffering(pre.providerId, "بلا سعر", walletId);

    const h = await dashboardService.priceHealth(db(), 1);
    expect(h.total).toBe(2);
    expect(h.ready).toBe(1);
    expect(h.needsAttention).toHaveLength(1);
    expect(h.needsAttention[0].offeringName).toBe("بلا سعر");
    expect(h.needsAttention[0].availability).toBe("NO_PRICE");
  });

  it("جاهزية البيع تطابق POS: السعر المتجاوز لمدة الصلاحية ليس جاهزاً", async () => {
    const pre = await mkProvider("مزوّد محدود الصلاحية", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const offeringId = await mkOffering(pre.providerId, "سعر صباحي", walletId);
    const priced = await publish(pre.providerId, 1, [{ offeringId, providerShare: "13400" }]);
    const price = priced.get(offeringId)!;

    await db()
      .update(s.digitalOfferings)
      .set({ priceValidityHours: 1 })
      .where(eq(s.digitalOfferings.id, offeringId));
    await db()
      .update(s.digitalPriceVersions)
      .set({ validFrom: new Date("2026-08-06T06:00:00.000Z") })
      .where(eq(s.digitalPriceVersions.id, price.pv));

    const h = await dashboardService.priceHealth(db(), 1, new Date("2026-08-06T08:00:01.000Z"));
    expect(h.ready).toBe(0);
    expect(h.needsAttention[0].availability).toBe("STALE_PRICE");
    expect(h.blockerCounts.STALE_PRICE).toBe(1);
  });

  it("جاهزية البيع لا تعلن بطاقةً مسبقة الدفع إذا لم يكف رصيد محفظتها لكرت واحد", async () => {
    const pre = await mkProvider("مزوّد منخفض الرصيد", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000");
    const offeringId = await mkOffering(pre.providerId, "كرت غير قابل للتنفيذ", walletId);
    await publish(pre.providerId, 1, [{ offeringId, providerShare: "13400" }]);

    const h = await dashboardService.priceHealth(db(), 1);
    expect(h.ready).toBe(0);
    expect(h.needsAttention[0].availability).toBe("INSUFFICIENT_BALANCE");
    expect(h.blockerCounts.INSUFFICIENT_BALANCE).toBe(1);
  });

  it("الحالات المعلّقة تُحصي NEEDS_REVIEW ولا تعدّ المُثبَّتة", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "كارت", walletId);
    const priced = await publish(pre.providerId, 1, [{ offeringId: a, providerShare: "13400" }]);

    await sell([{ offeringId: a, priced: priced.get(a)! }]); // مُثبَّتة ⇒ لا تُعدّ
    // نيّة نُفِّذ كرتُها ثم هُجرت ⇒ NEEDS_REVIEW
    const r = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "p-abandoned-1", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fpX",
      lines: [{ lineKey: "lkX", offeringId: a, priceVersionId: priced.get(a)!.pv, expectedSellPrice: priced.get(a)!.price }],
    }, actor));
    const [it] = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, r.intentId));
    await withTx(async (tx) => {
      const claimToken = `dashboard-abandoned-${it.id}`;
      await intentService.claimExecution(tx, { intentId: r.intentId, intentItemId: Number(it.id), claimToken }, actor);
      return intentService.markExecution(tx, {
        intentId: r.intentId, intentItemId: Number(it.id), claimToken, status: "SUCCESS", providerReference: "ABANDONED-1",
      }, actor);
    });
    await withTx((tx) => intentService.cancelIntent(tx, { intentId: r.intentId }, actor));

    const p = await dashboardService.pendingExecutions(db(), 1);
    expect(p.needsReview).toBe(1);
    expect(p.items.every((x) => x.status !== "FINALIZED")).toBe(true);
  });

  it("حالة المطابقات تُجمّع الفروق المفتوحة", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "100000");
    await withTx((tx) => walletOpsService.reconcile(tx, {
      walletId, businessDate: "2026-07-29", actualBalance: "96600",
    }, mgr));

    const rs = await dashboardService.reconciliationStatus(db(), scope());
    expect(rs.total).toBe(1);
    expect(rs.open).toBe(1);
    expect(Number(rs.openVarianceTotal)).toBe(-3400);
    const [agg] = await db()
      .select({ t: sql<string>`COALESCE(SUM(${s.digitalWalletReconciliations.variance}),0)` })
      .from(s.digitalWalletReconciliations);
    expect(Number(rs.openVarianceTotal)).toBe(Number(agg.t));
  });

  it("أكثر البطاقات مبيعاً مرتّبةٌ بالعدد ويطابق مجموعها الملخّص", async () => {
    const pre = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(pre.providerId, "1000000");
    const a = await mkOffering(pre.providerId, "الأكثر", walletId);
    const b = await mkOffering(pre.providerId, "الأقلّ", walletId);
    const priced = await publish(pre.providerId, 1, [
      { offeringId: a, providerShare: "13400" }, { offeringId: b, providerShare: "4150" },
    ]);
    await sell([{ offeringId: a, priced: priced.get(a)! }]);
    await sell([{ offeringId: a, priced: priced.get(a)! }]);
    await sell([{ offeringId: b, priced: priced.get(b)! }]);

    const top = await dashboardService.topOfferings(db(), scope());
    expect(top[0].offeringName).toBe("الأكثر");
    expect(top[0].cards).toBe(2);
    const sum = await dashboardService.summary(db(), scope());
    expect(top.reduce((acc, t) => acc + t.cards, 0)).toBe(sum.cards);
    expect(top.reduce((acc, t) => acc + Number(t.sales), 0)).toBe(Number(sum.sales));
  });
});
