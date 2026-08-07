import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { returnSale } from "../returnService";
import { withTx } from "../tx";
import {
  finalizeService, intentService, offeringService, pricingService,
  providerService, reversalService, walletOpsService, walletService,
} from "../digitalCards";

/**
 * البطاقات الرقمية — ش١٢: العكس والاستثناءات.
 * معيار الخروج: **العودة إلى صافي صفريّ عند العكس الكامل المؤكَّد**.
 */

const actor = { userId: 1, branchId: 1, role: "cashier" };
const mgr = { userId: 2, branchId: 1, role: "manager" };
/** مديرٌ ثانٍ — ردّ الخسارة يشترط معتمِداً غير الطالب (SOD، هجرة 0132). */
const mgr2 = { userId: 3, branchId: 1, role: "manager" };
const adminUser = { userId: 4, branchId: 1, role: "admin" };
const DATE = "2026-07-29";

const TABLES = [
  "digitalSubscriptionContracts", "digitalSaleDetails", "digitalSaleExecutionClaims", "digitalSaleIntentItems", "digitalWalletReservations", "digitalSaleIntents",
  "digitalWalletTransactions", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWallets", "digitalProviders",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "shifts", "auditLogs", "studentProfiles", "customers", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values([
    { id: 1, openId: "u1", name: "كاشير", role: "cashier", loginMethod: "local" },
    { id: 2, openId: "u2", name: "مدير", role: "manager", loginMethod: "local" },
    { id: 3, openId: "u3", name: "مدير ثانٍ", role: "manager", loginMethod: "local" },
    { id: 4, openId: "u4", name: "أدمن", role: "admin", loginMethod: "local" },
  ]);
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0" });
}

async function mkProvider(name: string, mode: "PREPAID" | "POSTPAID") {
  const { supplierId } = await createSupplier({ name }, { userId: 1, branchId: 1 });
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode: mode, recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
  }, { userId: 1, branchId: 1 }));
  return { providerId, supplierId };
}

async function mkWallet(providerId: number, balance: string) {
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(tx, { providerId, branchId: 1, code: "W1", name: "محفظة" }, { userId: 1, branchId: 1 }));
  await withTx((tx) => walletOpsService.deposit(tx, {
    walletId, amount: balance, paymentMethod: "CASH", clientRequestId: `dep-${Math.random().toString(36).slice(2, 10)}`,
  }, mgr));
  return walletId;
}

async function mkOffering(providerId: number, name: string, walletId: number | null) {
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: "TELECOM_CARD", name, pricingMode: "FIXED_MARGIN",
    fixedMargin: "850", roundingStep: "0", branches: [{ branchId: 1, walletId }],
  }, { userId: 1, branchId: 1 }));
  return r.offeringId;
}

async function publish(providerId: number, lines: { offeringId: number; providerShare: string }[]) {
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: DATE }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.publish(tx, { batchId }, { userId: 1, branchId: 1 }));
  const rows = await db()
    .select({ offeringId: s.digitalCurrentPrices.offeringId, pv: s.digitalCurrentPrices.priceVersionId, price: s.digitalPriceVersions.sellPrice })
    .from(s.digitalCurrentPrices)
    .innerJoin(s.digitalPriceVersions, eq(s.digitalCurrentPrices.priceVersionId, s.digitalPriceVersions.id))
    .where(eq(s.digitalCurrentPrices.branchId, 1));
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
      providerReference: `REF-REV-${id}-${i}`,
    })),
  }, actor));
  const items = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, r.intentId));
  for (const it of items) {
    await withTx(async (tx) => {
      const claimToken = `reversal-claim-${id}-${it.id}`;
      await intentService.claimExecution(tx, { intentId: r.intentId, intentItemId: Number(it.id), claimToken }, actor);
      return intentService.markExecution(tx, {
        intentId: r.intentId, intentItemId: Number(it.id), claimToken, status: "SUCCESS", providerReference: it.providerReference,
      }, actor);
    });
  }
  const total = offerings.reduce((a, o) => a + Number(o.priced.price), 0);
  return withTx((tx) => finalizeService.finalize(tx, {
    intentId: r.intentId, clientRequestId: `f-${id}-${Math.random().toString(36).slice(2, 9)}`,
    paymentAmount: total.toFixed(2), paymentMethod: "CASH",
  }, actor));
}

async function detailIds(invoiceId: number) {
  const rows = await reversalService.reversibleDetails(db(), invoiceId);
  return rows.map((r) => r.id);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
  seq = 0;
});

describe("ش١٢ — حظر المرتجع العام", () => {
  it("المرتجع العادي يرفض بند الكرت الرقميّ ويوجّه لمسار العكس", async () => {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "1000000");
    const o = await mkOffering(providerId, "كارت", walletId);
    const priced = await publish(providerId, [{ offeringId: o, providerShare: "13400" }]);
    const sale = await sell([{ offeringId: o, priced: priced.get(o)! }]);

    const [item] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    await expect(returnSale({
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: Number(item.id), baseQuantity: 1 }],
      refundMethod: "CASH",
    } as never, mgr)).rejects.toThrow(/عكس بيع الكروت/);

    // ولا أثر: البند ما زال ISSUED.
    const d = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(d[0].fulfillmentStatus).toBe("ISSUED");
  });
});

describe("ش١٢ — معيار الخروج: صافي صفريّ عند العكس الكامل المؤكَّد", () => {
  it("مسبق الدفع: الدفتر يعود صفراً والمحفظة تعود لرصيدها", async () => {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "1000000");
    const o = await mkOffering(providerId, "كارت", walletId);
    const priced = await publish(providerId, [{ offeringId: o, providerShare: "13400" }]);

    const [wBefore] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    const sale = await sell([{ offeringId: o, priced: priced.get(o)! }]);
    const [wAfterSale] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(Number(wAfterSale.currentBalance)).toBe(Number(wBefore.currentBalance) - 13400);

    const ids = await detailIds(sale.invoiceId);
    const res = await withTx((tx) => reversalService.approveReversal(tx, {
      invoiceId: sale.invoiceId, detailIds: ids, reason: "المزوّد ألغى الكرت",
    }, mgr));
    expect(res.outcome).toBe("REVERSED");
    expect(res.refunded).toBe("14250.00");

    // ✦ صافي الدفتر صفر في الثلاثة.
    const net = await reversalService.netForInvoice(db(), sale.invoiceId);
    expect(Number(net.revenue)).toBe(0);
    expect(Number(net.cost)).toBe(0);
    expect(Number(net.profit)).toBe(0);

    // ✦ المحفظة عادت لرصيدها قبل البيع.
    const [wAfterRev] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(wAfterRev.currentBalance).toBe(wBefore.currentBalance);
    expect(await walletOpsService.assertBalanceReproducible(db(), walletId)).toBe(true);

    // ✦ حركة عكسٍ واردة + قيد أصلٍ صفريّ.
    const revTx = await db().select().from(s.digitalWalletTransactions)
      .where(eq(s.digitalWalletTransactions.type, "SALE_REVERSAL"));
    expect(revTx).toHaveLength(1);
    expect(revTx[0].direction).toBe("IN");
    const revEntry = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "DIGITAL_WALLET_REVERSAL"));
    expect(revEntry[0].profit).toBe("0.00");

    // ✦ البند صار REVERSED واسترداد الزبون مسجَّل.
    const d = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(d[0].fulfillmentStatus).toBe("REVERSED");
    const out = await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, sale.invoiceId));
    expect(out.some((r) => r.direction === "OUT" && r.amount === "14250.00")).toBe(true);
  });

  it("الآجل: الدفتر يعود صفراً وذمّة المزوّد تعود لما كانت", async () => {
    const { providerId, supplierId } = await mkProvider("منصّة", "POSTPAID");
    const o = await mkOffering(providerId, "اشتراك", null);
    const priced = await publish(providerId, [{ offeringId: o, providerShare: "80000" }]);

    const sale = await sell([{ offeringId: o, priced: priced.get(o)! }]);
    const [supAfterSale] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId));
    expect(supAfterSale.currentBalance).toBe("80000.00");

    const ids2 = await detailIds(sale.invoiceId);
    await withTx((tx) => reversalService.approveReversal(tx, {
      invoiceId: sale.invoiceId, detailIds: ids2, reason: "المنصّة ألغت الاشتراك",
    }, mgr));

    const net = await reversalService.netForInvoice(db(), sale.invoiceId);
    expect(Number(net.revenue)).toBe(0);
    expect(Number(net.cost)).toBe(0);
    expect(Number(net.profit)).toBe(0);

    const [supAfterRev] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId));
    expect(Number(supAfterRev.currentBalance)).toBe(0);
    // ولا حركة محفظة للآجل.
    expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(0);
  });

  it("عكسٌ جزئيّ لفاتورة متعدّدة: المعكوس فقط يتلاشى والباقي يبقى", async () => {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "1000000");
    const a = await mkOffering(providerId, "كارت أ", walletId);
    const b = await mkOffering(providerId, "كارت ب", walletId);
    const priced = await publish(providerId, [
      { offeringId: a, providerShare: "13400" }, { offeringId: b, providerShare: "4150" },
    ]);
    const sale = await sell([
      { offeringId: a, priced: priced.get(a)! }, { offeringId: b, priced: priced.get(b)! },
    ]);

    const all = await reversalService.reversibleDetails(db(), sale.invoiceId);
    const first = all.find((d) => d.sellPrice === "14250.00")!;
    await withTx((tx) => reversalService.approveReversal(tx, {
      invoiceId: sale.invoiceId, detailIds: [first.id], reason: "الكرت الأول ملغى",
    }, mgr));

    // الصافي = ما تبقّى من البيع الثاني (5000 بيع، 4150 حصة، 850 ربح).
    const net = await reversalService.netForInvoice(db(), sale.invoiceId);
    expect(Number(net.revenue)).toBe(5000);
    expect(Number(net.cost)).toBe(4150);
    expect(Number(net.profit)).toBe(850);

    const after = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(after.filter((d) => d.fulfillmentStatus === "REVERSED")).toHaveLength(1);
    expect(after.filter((d) => d.fulfillmentStatus === "ISSUED")).toHaveLength(1);
  });
});

describe("ش١٢ — ردّ الخسارة", () => {
  it("الزبون يُسترَدّ والحصة تبقى خسارةً على المكتبة — لا رصيد يعود", async () => {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "1000000");
    const o = await mkOffering(providerId, "كارت", walletId);
    const priced = await publish(providerId, [{ offeringId: o, providerShare: "13400" }]);
    const sale = await sell([{ offeringId: o, priced: priced.get(o)! }]);
    const [wAfterSale] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));

    const ids3 = await detailIds(sale.invoiceId);
    // الطلب أوّلاً — بلا أثرٍ ماليّ — ثمّ اعتماد مديرٍ آخر (SOD، هجرة 0132).
    const req = await withTx((tx) => reversalService.requestLossRefund(tx, {
      invoiceId: sale.invoiceId, detailIds: ids3, reason: "المزوّد رفض الإلغاء",
    }, mgr));
    expect(req.requested).toBe(1);
    const netPending = await reversalService.netForInvoice(db(), sale.invoiceId);
    expect(Number(netPending.profit)).not.toBe(-13400);   // لا خسارة قبل الاعتماد

    const res = await withTx((tx) => reversalService.lossRefund(tx, {
      invoiceId: sale.invoiceId, detailIds: ids3,
    }, mgr2));
    expect(res.outcome).toBe("LOSS_REFUND");
    expect(res.loss).toBe("13400.00");

    // الإيراد تلاشى، والتكلفة بقيت ⇒ خسارةٌ ظاهرة بمقدار الحصة.
    const net = await reversalService.netForInvoice(db(), sale.invoiceId);
    expect(Number(net.revenue)).toBe(0);
    expect(Number(net.cost)).toBe(13400);
    expect(Number(net.profit)).toBe(-13400);

    // المحفظة **لم** تُردّ إليها الحصة.
    const [wAfterLoss] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(wAfterLoss.currentBalance).toBe(wAfterSale.currentBalance);
    expect(await db().select().from(s.digitalWalletTransactions)
      .where(eq(s.digitalWalletTransactions.type, "SALE_REVERSAL"))).toHaveLength(0);

    const d = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(d[0].fulfillmentStatus).toBe("LOSS_REFUND");
  });
});

describe("ش١٢ — الحوكمة والذرّية", () => {
  async function issued() {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "1000000");
    const o = await mkOffering(providerId, "كارت", walletId);
    const priced = await publish(providerId, [{ offeringId: o, providerShare: "13400" }]);
    const sale = await sell([{ offeringId: o, priced: priced.get(o)! }]);
    return { sale, walletId, ids: await detailIds(sale.invoiceId) };
  }

  it("الكاشير لا يعكس؛ القرار مديريّ", async () => {
    const { sale, ids } = await issued();
    await expect(withTx((tx) => reversalService.approveReversal(tx, {
      invoiceId: sale.invoiceId, detailIds: ids, reason: "محاولة",
    }, actor))).rejects.toThrow(/قرارٌ مديريّ/);
  });

  it("لا عكس مرّتين لنفس البند", async () => {
    const { sale, ids } = await issued();
    await withTx((tx) => reversalService.approveReversal(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "أول" }, mgr));
    await expect(withTx((tx) => reversalService.approveReversal(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "ثانٍ" }, mgr)))
      .rejects.toThrow(/عولِج مسبقاً/);
    await expect(withTx((tx) => reversalService.requestLossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "ثالث" }, mgr)))
      .rejects.toThrow(/عولِج مسبقاً/);
  });

  it("السبب إلزاميّ", async () => {
    const { sale, ids } = await issued();
    await expect(withTx((tx) => reversalService.approveReversal(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "  " }, mgr)))
      .rejects.toThrow(/سبب العكس مطلوب/);
  });

  it("فشلٌ بعد العكس يُرجِع كل شيء (ذرّية)", async () => {
    const { sale, walletId, ids } = await issued();
    const [wBefore] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    const entriesBefore = (await db().select().from(s.accountingEntries)).length;

    await expect(withTx(async (tx) => {
      await reversalService.approveReversal(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "عكس" }, mgr);
      throw new Error("فشل مُصطنع بعد العكس");
    })).rejects.toThrow(/فشل مُصطنع/);

    const [wAfter] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(wAfter.currentBalance).toBe(wBefore.currentBalance);
    expect((await db().select().from(s.accountingEntries)).length).toBe(entriesBefore);
    const d = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(d[0].fulfillmentStatus).toBe("ISSUED");
  });

  it("العكس يُسجَّل في التدقيق", async () => {
    const { sale, ids } = await issued();
    await withTx((tx) => reversalService.approveReversal(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "سبب واضح" }, mgr));
    const logs = await db().select().from(s.auditLogs)
      .where(eq(s.auditLogs.action, "digitalCards.reversal.approved"));
    expect(logs).toHaveLength(1);
  });

  it("reversal cancels the subscription contract tied to the reversed invoice item", async () => {
    const { sale, ids } = await issued();
    const [detail] = await db().select().from(s.digitalSaleDetails)
      .where(eq(s.digitalSaleDetails.id, ids[0]));
    await db().insert(s.customers).values({ id: 10, name: "Student" });
    await db().insert(s.digitalSubscriptionContracts).values({
      offeringId: Number(detail.offeringId),
      branchId: 1,
      invoiceId: sale.invoiceId,
      invoiceItemId: Number(detail.invoiceItemId),
      studentCustomerId: 10,
      studentNameSnapshot: "Student",
      durationDays: 30,
      startsAt: new Date("2026-08-01T00:00:00Z"),
      expiresAt: new Date("2026-08-31T00:00:00Z"),
      createdBy: 1,
    });

    await withTx((tx) => reversalService.approveReversal(tx, {
      invoiceId: sale.invoiceId,
      detailIds: ids,
      reason: "provider cancelled the issued subscription",
    }, mgr));

    const [contract] = await db().select().from(s.digitalSubscriptionContracts);
    expect(contract.status).toBe("CANCELLED");
  });
});

/**
 * ردّ الخسارة باعتمادٍ ثانٍ (هجرة 0132، قرار المالك ٣٠/٧/٢٦).
 *
 * L1 — الطلب **لا يمسّ مالاً**: لا استرداد ولا قيد ولا خسارة.
 * L2 — SOD: لا يعتمد الطلبَ مَن قدّمه (admin مُستثنى)، وكذلك الرفض.
 * L3 — لا يُعتمَد ردٌّ لم يُطلَب.
 * L4 — الرفض يُعيد البند إلى ISSUED بلا أثرٍ ماليّ ويمسح أثر الطلب.
 * L5 — **العكس المؤكَّد يبقى بفاعلٍ واحد** — صافيه صفر فلا خسارة تُعتمَد.
 */
describe("ش١٢ — ردّ الخسارة بفصل المهام", () => {
  async function issued() {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "1000000");
    const o = await mkOffering(providerId, "كارت", walletId);
    const priced = await publish(providerId, [{ offeringId: o, providerShare: "13400" }]);
    const sale = await sell([{ offeringId: o, priced: priced.get(o)! }]);
    return { sale, walletId, ids: await detailIds(sale.invoiceId) };
  }

  it("L1: الطلب يغيّر الحالة فقط — لا استرداد ولا قيد", async () => {
    const { sale, ids } = await issued();
    const receiptsBefore = (await db().select().from(s.receipts)).length;
    const entriesBefore = (await db().select().from(s.accountingEntries)).length;

    const r = await withTx((tx) => reversalService.requestLossRefund(tx, {
      invoiceId: sale.invoiceId, detailIds: ids, reason: "المزوّد رفض الإلغاء",
    }, mgr));
    expect(r.requested).toBe(1);
    expect(r.loss).toBe("13400.00");

    expect((await db().select().from(s.receipts)).length).toBe(receiptsBefore);
    expect((await db().select().from(s.accountingEntries)).length).toBe(entriesBefore);

    const d = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(d[0].fulfillmentStatus).toBe("LOSS_REFUND_PENDING");
    expect(Number(d[0].lossRefundRequestedBy)).toBe(mgr.userId);
  });

  it("L2: لا يعتمد الطلبَ مَن قدّمه، ويعتمده مديرٌ آخر", async () => {
    const { sale, ids } = await issued();
    await withTx((tx) => reversalService.requestLossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "سبب" }, mgr));

    await expect(withTx((tx) => reversalService.lossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids }, mgr)))
      .rejects.toThrow(/مديرٌ آخر/);

    const res = await withTx((tx) => reversalService.lossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids }, mgr2));
    expect(res.loss).toBe("13400.00");
    const net = await reversalService.netForInvoice(db(), sale.invoiceId);
    expect(Number(net.profit)).toBe(-13400);
  });

  it("L2: الأدمن مُستثنى من SOD", async () => {
    const { sale, ids } = await issued();
    await withTx((tx) => reversalService.requestLossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "سبب" }, adminUser));
    await withTx((tx) => reversalService.lossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids }, adminUser));
    const d = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(d[0].fulfillmentStatus).toBe("LOSS_REFUND");
  });

  it("L3: لا يُعتمَد ردٌّ لم يُطلَب", async () => {
    const { sale, ids } = await issued();
    await expect(withTx((tx) => reversalService.lossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids }, mgr2)))
      .rejects.toThrow(/ليس عليه طلب ردّ خسارةٍ معلّق/);
  });

  it("L4: الرفض يُعيدها إلى ISSUED بلا أثرٍ ماليّ ويمسح أثر الطلب", async () => {
    const { sale, ids } = await issued();
    await withTx((tx) => reversalService.requestLossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "سبب" }, mgr));
    const receiptsBefore = (await db().select().from(s.receipts)).length;

    await expect(withTx((tx) => reversalService.rejectLossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids }, mgr)))
      .rejects.toThrow(/مديرٌ آخر/);   // الرفض أيضاً محكومٌ بـSOD

    await withTx((tx) => reversalService.rejectLossRefund(tx, { invoiceId: sale.invoiceId, detailIds: ids, reason: "غير مبرَّر" }, mgr2));

    const d = await reversalService.reversibleDetails(db(), sale.invoiceId);
    expect(d[0].fulfillmentStatus).toBe("ISSUED");
    expect(d[0].lossRefundRequestedBy).toBeNull();
    expect(d[0].lossRefundReason).toBeNull();
    expect((await db().select().from(s.receipts)).length).toBe(receiptsBefore);
  });

  it("L5: العكس المؤكَّد يبقى بفاعلٍ واحد — صافيه صفر فلا خسارة تُعتمَد", async () => {
    const { sale, ids } = await issued();
    await withTx((tx) => reversalService.approveReversal(tx, {
      invoiceId: sale.invoiceId, detailIds: ids, reason: "المزوّد أعاد الحصة",
    }, mgr));
    const net = await reversalService.netForInvoice(db(), sale.invoiceId);
    expect(Number(net.revenue)).toBe(0);
    expect(Number(net.cost)).toBe(0);
    expect(Number(net.profit)).toBe(0);
  });
});
