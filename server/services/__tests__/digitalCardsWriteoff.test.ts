import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import {
  intentService, offeringService, pricingService, providerService, walletService, writeoffService,
} from "../digitalCards";

/**
 * البطاقات الرقمية — شطب النيّة العالقة (٣٠/٧/٢٦، قرار المالك: شطبٌ باعتمادٍ ثنائيّ).
 *
 * الثوابت المحروسة هنا:
 *   I1 — الطلب **لا يمسّ مالاً**: لا رصيد ولا حجز ولا قيد.
 *   I2 — SOD: لا يعتمد الشطبَ مَن طلبه (admin مُستثنى).
 *   I3 — المسبق: الرصيد ينزل بالحصة والحجز يُستهلَك (لا يُطلَق) ⇒ المتاح لا يتضخّم كذباً.
 *   I4 — الآجل: ذمّة المزوّد ترتفع بالحصة (لا محفظة ولا حجز).
 *   I5 — القيد خسارة صريحة: revenue=0، cost=الحصة، profit=−الحصة (لا حركة أصلٍ صفرية).
 *   I6 — لا شطب مرّتين، ولا شطب لنيّةٍ بلا كرتٍ صادر، ولا لنيّةٍ خارج المراجعة.
 */

const cashier = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
const manager2 = { userId: 3, branchId: 1, role: "manager" };
const admin = { userId: 4, branchId: 1, role: "admin" };
const DATE = "2026-07-30";

const TABLES = [
  "digitalSaleExecutionClaims", "digitalSaleIntentItems", "digitalWalletReservations", "digitalSaleIntents",
  "digitalPriceChangeReports", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWalletTransactions", "digitalWallets", "digitalProviders",
  "accountingEntries", "shifts", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "auditLogs", "studentProfiles", "customers", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([
    { id: 1, openId: "u1", name: "كاشير", role: "cashier", loginMethod: "local" },
    { id: 2, openId: "u2", name: "مدير", role: "manager", loginMethod: "local" },
    { id: 3, openId: "u3", name: "مدير ثانٍ", role: "manager", loginMethod: "local" },
    { id: 4, openId: "u4", name: "أدمن", role: "admin", loginMethod: "local" },
  ]);
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0" });
}

async function mkProvider(mode: "PREPAID" | "POSTPAID", name: string) {
  const { supplierId } = await createSupplier({ name }, { userId: 1, branchId: 1 });
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(tx, {
      supplierId, providerType: "TELECOM", settlementMode: mode,
      recognitionMode: "PRINCIPAL_GROSS", referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
    }, { userId: 1, branchId: 1 }),
  );
  return { providerId, supplierId };
}

async function mkWallet(providerId: number, balance: string, code = "W1") {
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(tx, { providerId, branchId: 1, code, name: `محفظة ${code}` }, { userId: 1, branchId: 1 }),
  );
  await db().update(s.digitalWallets).set({ currentBalance: balance }).where(eq(s.digitalWallets.id, walletId));
  return walletId;
}

async function mkOffering(providerId: number, walletId: number | null, name = "كارت ١٠ آلاف") {
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: "TELECOM_CARD", name,
    pricingMode: "FIXED_MARGIN", fixedMargin: "500", roundingStep: "250",
    branches: [{ branchId: 1, walletId }],
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

/** نيّةٌ عالقة واقعية: كرتٌ صدر بنجاح ثمّ لم تُثبَّت الفاتورة ⇒ NEEDS_REVIEW. */
async function stuckIntent(offeringId: number, priced: { pv: number; price: string }, seq = 1) {
  const r = await withTx((tx) => intentService.prepare(tx, {
    clientRequestId: `woff-req-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: `fp-${seq}`,
    lines: [{ lineKey: `lk-${seq}`, offeringId, priceVersionId: priced.pv, expectedSellPrice: priced.price, providerReference: `REF-WOFF-${seq}` }],
  }, cashier));
  const [item] = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, r.intentId));
  await withTx(async (tx) => {
    const claimToken = `writeoff-claim-${seq}-${item.id}`;
    await intentService.claimExecution(tx, { intentId: r.intentId, intentItemId: Number(item.id), claimToken }, cashier);
    return intentService.markExecution(tx, {
      intentId: r.intentId, intentItemId: Number(item.id), claimToken, status: "SUCCESS", providerReference: item.providerReference,
    }, cashier);
  });
  await db().update(s.digitalSaleIntents).set({ status: "NEEDS_REVIEW" }).where(eq(s.digitalSaleIntents.id, r.intentId));
  return r.intentId;
}

async function walletRow(id: number) {
  const [w] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, id));
  return w;
}
async function intentRow(id: number) {
  const [i] = await db().select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id, id));
  return i;
}
async function writeoffEntries() {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "DIGITAL_WRITEOFF"));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("الشطب — الطلب (بلا أثرٍ ماليّ)", () => {
  it("I1: الطلب يغيّر الحالة فقط — لا رصيد ولا حجز ولا قيد", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    const before = await walletRow(walletId);
    const r = await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "الكرت لم يُسلَّم" }, manager));

    expect(r.issuedCount).toBe(1);
    expect(r.amount).toBe("9500.00");
    const after = await walletRow(walletId);
    expect(after.currentBalance).toBe(before.currentBalance);
    expect(after.reservedBalance).toBe(before.reservedBalance);
    expect(await writeoffEntries()).toHaveLength(0);

    const i = await intentRow(intentId);
    expect(i.status).toBe("WRITEOFF_PENDING");
    expect(Number(i.writeoffRequestedBy)).toBe(manager.userId);
    expect(i.writeoffReason).toBe("الكرت لم يُسلَّم");
  });

  it("I6: لا يُشطَب إلا ما كان تحت المراجعة، ولا طلبان معاً", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "سبب أول" }, manager));
    await expect(
      withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "سبب ثانٍ" }, manager2)),
    ).rejects.toThrow(/معلّق/);

    // نيّةٌ مثبَّتة (PREPARED هنا كافية للدلالة على «خارج المراجعة»)
    const other = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "woff-other-1", branchId: 1, shiftId: 1, paymentMethod: "CASH",
      cartFingerprint: "fp-other", lines: [{ lineKey: "lk-other", offeringId, priceVersionId: priced.get(offeringId)!.pv, expectedSellPrice: priced.get(offeringId)!.price, providerReference: "REF-WOFF-OTHER" }],
    }, cashier));
    await expect(
      withTx((tx) => writeoffService.requestWriteoff(tx, { intentId: other.intentId, reason: "محاولة" }, manager)),
    ).rejects.toThrow(/تحت المراجعة/);
  });

  it("I6: نيّةٌ بلا كرتٍ صادر تُرفَض — تُلغى بلا خسارة", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const p = priced.get(offeringId)!;

    const r = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "woff-none-1", branchId: 1, shiftId: 1, paymentMethod: "CASH",
      cartFingerprint: "fp-none", lines: [{ lineKey: "lk-none", offeringId, priceVersionId: p.pv, expectedSellPrice: p.price, providerReference: "REF-WOFF-NONE" }],
    }, cashier));
    await db().update(s.digitalSaleIntents).set({ status: "NEEDS_REVIEW" }).where(eq(s.digitalSaleIntents.id, r.intentId));

    await expect(
      withTx((tx) => writeoffService.requestWriteoff(tx, { intentId: r.intentId, reason: "محاولة" }, manager)),
    ).rejects.toThrow(/لا كرت صادراً/);
  });

  it("الشطب قرارٌ مديريّ — الكاشير مرفوض", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await expect(
      withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "محاولة كاشير" }, cashier)),
    ).rejects.toThrow(/مديريّ/);
  });
});

describe("الشطب — الاعتماد (SOD وكلّ الأثر المالي)", () => {
  it("I2: لا يعتمد الشطبَ مَن طلبه، ويعتمده مديرٌ آخر", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "لم يُسلَّم" }, manager));
    await expect(
      withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, manager)),
    ).rejects.toThrow(/مديرٌ آخر/);

    const r = await withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, manager2));
    expect(r.loss).toBe("9500.00");
    expect((await intentRow(intentId)).status).toBe("WRITTEN_OFF");
  });

  it("I2: الأدمن مُستثنى من SOD (تصحيح إداريّ)", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "لم يُسلَّم" }, admin));
    await withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, admin));
    expect((await intentRow(intentId)).status).toBe("WRITTEN_OFF");
  });

  it("I3 + I5: المسبق — الرصيد ينزل بالحصة، الحجز يُستهلَك، والقيد خسارة صريحة", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    const before = await walletRow(walletId);
    expect(before.currentBalance).toBe("100000.00");
    expect(before.reservedBalance).toBe("9500.00");

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "لم يُسلَّم" }, manager));
    await withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, manager2));

    const after = await walletRow(walletId);
    expect(after.currentBalance).toBe("90500.00");   // نزل بالحصة — يطابق ما خصمه الجهاز
    expect(after.reservedBalance).toBe("0.00");      // الحجز استُهلك لا أُطلق

    const [res] = await db().select().from(s.digitalWalletReservations).where(eq(s.digitalWalletReservations.intentId, intentId));
    expect(res.status).toBe("CONSUMED");

    const [tx] = await db().select().from(s.digitalWalletTransactions).where(eq(s.digitalWalletTransactions.type, "WRITEOFF"));
    expect(tx.direction).toBe("OUT");
    expect(tx.amount).toBe("9500.00");
    expect(tx.balanceAfter).toBe("90500.00");

    const entries = await writeoffEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].revenue).toBe("0.00");
    expect(entries[0].cost).toBe("9500.00");
    expect(entries[0].profit).toBe("-9500.00");
    // بلا فاتورة ⇒ خارج وعاء العمولة تلقائياً (INNER JOIN الفواتير يستبعده).
    expect(entries[0].invoiceId).toBeNull();
  });

  it("PREPAID partial success charges only successful cards and releases the remainder", async () => {
    const { providerId } = await mkProvider("PREPAID", "Partial provider");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const price = priced.get(offeringId)!;
    const prepared = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "woff-partial-success",
      branchId: 1,
      shiftId: 1,
      paymentMethod: "CASH",
      cartFingerprint: "partial-success",
      lines: [
        { lineKey: "partial-ok", offeringId, priceVersionId: price.pv, expectedSellPrice: price.price, providerReference: "PARTIAL-OK" },
        { lineKey: "partial-failed", offeringId, priceVersionId: price.pv, expectedSellPrice: price.price, providerReference: "PARTIAL-FAILED" },
      ],
    }, cashier));
    const intentItems = await db().select().from(s.digitalSaleIntentItems)
      .where(eq(s.digitalSaleIntentItems.intentId, prepared.intentId));
    const okItem = intentItems.find((item) => item.lineKey === "partial-ok")!;
    const failedItem = intentItems.find((item) => item.lineKey === "partial-failed")!;
    await withTx(async (tx) => {
      const claimToken = `writeoff-partial-ok-${okItem.id}`;
      await intentService.claimExecution(tx, { intentId: prepared.intentId, intentItemId: Number(okItem.id), claimToken }, cashier);
      return intentService.markExecution(tx, {
        intentId: prepared.intentId,
        intentItemId: Number(okItem.id),
        claimToken,
        status: "SUCCESS",
        providerReference: "PARTIAL-OK",
      }, cashier);
    });
    await withTx(async (tx) => {
      const claimToken = `writeoff-partial-failed-${failedItem.id}`;
      await intentService.claimExecution(tx, { intentId: prepared.intentId, intentItemId: Number(failedItem.id), claimToken }, cashier);
      return intentService.markExecution(tx, {
        intentId: prepared.intentId,
        intentItemId: Number(failedItem.id),
        claimToken,
        status: "FAILED",
        providerReference: null,
      }, cashier);
    });

    await withTx((tx) => writeoffService.requestWriteoff(tx, {
      intentId: prepared.intentId,
      reason: "second card was not issued",
    }, manager));
    await withTx((tx) => writeoffService.approveWriteoff(tx, { intentId: prepared.intentId }, manager2));

    const wallet = await walletRow(walletId);
    expect(wallet.currentBalance).toBe("90500.00");
    expect(wallet.reservedBalance).toBe("0.00");
    const [reservation] = await db().select().from(s.digitalWalletReservations)
      .where(eq(s.digitalWalletReservations.intentId, prepared.intentId));
    expect(reservation.amount).toBe("9500.00");
    expect(reservation.status).toBe("CONSUMED");
    const [walletTx] = await db().select().from(s.digitalWalletTransactions)
      .where(eq(s.digitalWalletTransactions.type, "WRITEOFF"));
    expect(walletTx.amount).toBe("9500.00");
  });

  it("I4: الآجل — ذمّة المزوّد ترتفع بالحصة ولا محفظة تُمسّ", async () => {
    const { providerId, supplierId } = await mkProvider("POSTPAID", "كورك آجل");
    const offeringId = await mkOffering(providerId, null);
    const priced = await publish(providerId, [{ offeringId, providerShare: "7000" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "لم يُسلَّم" }, manager));
    await withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, manager2));

    const [sup] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId));
    expect(sup.currentBalance).toBe("7000.00");     // علينا له

    const entries = await writeoffEntries();
    expect(entries[0].cost).toBe("7000.00");
    expect(entries[0].profit).toBe("-7000.00");
    const [payable] = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `DIGITAL:APWOFF:${intentId}:${providerId}`));
    expect(Number(payable.supplierId)).toBe(supplierId);
    expect(payable.entryType).toBe("PURCHASE");
    expect(payable.amount).toBe("7000.00");
    // لا حركة محفظة إطلاقاً في المسار الآجل.
    expect(await db().select().from(s.digitalWalletTransactions)).toHaveLength(0);
  });

  it("I6: لا شطب مرّتين", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "لم يُسلَّم" }, manager));
    await withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, manager2));
    await expect(
      withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, manager2)),
    ).rejects.toThrow(/مشطوبة مسبقاً/);

    expect(await writeoffEntries()).toHaveLength(1);   // قيدٌ واحد لا اثنان
  });

  it("الاعتماد بلا طلبٍ معلّق مرفوض", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await expect(
      withTx((tx) => writeoffService.approveWriteoff(tx, { intentId }, manager2)),
    ).rejects.toThrow(/لا طلب شطبٍ معلّقاً/);
  });
});

describe("الشطب — الرفض والطابور", () => {
  it("الرفض يعيدها للطابور بلا أثرٍ ماليّ ويمسح أثر الطلب", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "9500" }]);
    const intentId = await stuckIntent(offeringId, priced.get(offeringId)!);

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId, reason: "لم يُسلَّم" }, manager));
    await withTx((tx) => writeoffService.rejectWriteoff(tx, { intentId, reason: "أعِد المحاولة مع المزوّد" }, manager2));

    const i = await intentRow(intentId);
    expect(i.status).toBe("NEEDS_REVIEW");
    expect(i.writeoffRequestedBy).toBeNull();
    expect(i.writeoffReason).toBeNull();

    const w = await walletRow(walletId);
    expect(w.currentBalance).toBe("100000.00");
    expect(w.reservedBalance).toBe("9500.00");   // الحجز باقٍ كما كان
    expect(await writeoffEntries()).toHaveLength(0);
  });

  it("الطابور يعرض المعلّق والمفتوح معاً، ويُخفي المشطوب", async () => {
    const { providerId } = await mkProvider("PREPAID", "آسياسيل");
    const walletId = await mkWallet(providerId, "100000");
    const a = await mkOffering(providerId, walletId, "كارت أ");
    const b = await mkOffering(providerId, walletId, "كارت ب");
    const priced = await publish(providerId, [
      { offeringId: a, providerShare: "9500" },
      { offeringId: b, providerShare: "9500" },
    ]);
    const openId = await stuckIntent(a, priced.get(a)!, 1);
    const pendingId = await stuckIntent(b, priced.get(b)!, 2);

    await withTx((tx) => writeoffService.requestWriteoff(tx, { intentId: pendingId, reason: "لم يُسلَّم" }, manager));

    let queue = await intentService.listNeedsReview(db(), { branchId: 1 });
    expect(queue.map((q) => Number(q.id)).sort()).toEqual([openId, pendingId].sort());
    expect(queue.find((q) => Number(q.id) === pendingId)!.status).toBe("WRITEOFF_PENDING");

    await withTx((tx) => writeoffService.approveWriteoff(tx, { intentId: pendingId }, manager2));
    queue = await intentService.listNeedsReview(db(), { branchId: 1 });
    expect(queue.map((q) => Number(q.id))).toEqual([openId]);   // المشطوب خرج من الطابور
  });
});
