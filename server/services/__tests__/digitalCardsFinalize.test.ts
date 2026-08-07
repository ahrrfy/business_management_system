import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import {
  finalizeService, intentService, offeringService, pricingService, providerService, subscriptionService, walletService,
} from "../digitalCards";

/**
 * البطاقات الرقمية — ش٨: التثبيت المالي.
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §٦ + §٩.٢ + §١٠.٣.
 */

const actor = { userId: 1, branchId: 1, role: "cashier" };
const DATE = "2026-07-29";

const TABLES = [
  "digitalSubscriptionContracts",
  "digitalSaleDetails", "digitalSaleExecutionClaims", "digitalSaleIntentItems", "digitalWalletReservations", "digitalSaleIntents",
  "digitalWalletTransactions", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWallets", "digitalProviders",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices", "idempotencyKeys",
  "branchStock", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "shifts", "auditLogs", "studentProfiles", "customers", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "u1", name: "كاشير", role: "cashier", loginMethod: "local" });
  await db().insert(s.shifts).values({ id: 1, branchId: 1, userId: 1, status: "OPEN", openingBalance: "0" });
}

async function mkProvider(name: string, settlementMode: "PREPAID" | "POSTPAID") {
  const { supplierId } = await createSupplier({ name }, { userId: 1, branchId: 1 });
  const { providerId } = await withTx((tx) => providerService.createProvider(tx, {
    supplierId, providerType: "TELECOM", settlementMode, recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
  }, { userId: 1, branchId: 1 }));
  return { providerId, supplierId };
}

async function mkWallet(providerId: number, balance: string, code = "W1") {
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(tx, { providerId, branchId: 1, code, name: `محفظة ${code}` }, { userId: 1, branchId: 1 }));
  await db().update(s.digitalWallets).set({ currentBalance: balance }).where(eq(s.digitalWallets.id, walletId));
  return walletId;
}

async function mkOffering(providerId: number, name: string, walletId: number | null, edu = false) {
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: edu ? "EDUCATIONAL_SUBSCRIPTION" : "TELECOM_CARD", name,
    requiresStudentData: edu, subscriptionDurationDays: edu ? 30 : null,
    pricingMode: "FIXED_MARGIN", fixedMargin: "850", roundingStep: "0",
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

let seq = 0;
async function prepareAndExecute(
  lines: { offeringId: number; priced: { pv: number; price: string }; student?: intentService.PrepareLine["student"] }[],
) {
  const id = ++seq;
  const r = await withTx((tx) => intentService.prepare(tx, {
    clientRequestId: `prep-${id}-${Math.random().toString(36).slice(2, 8)}`,
    branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: `fp${id}`,
    lines: lines.map((l, i) => ({
      lineKey: `lk-${id}-${i}`, offeringId: l.offeringId, priceVersionId: l.priced.pv,
      expectedSellPrice: l.priced.price, providerReference: `REF-FIN-${id}-${i}`, student: l.student ?? null,
    })),
  }, actor));
  const items = await db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, r.intentId));
  for (const it of items) {
    await withTx(async (tx) => {
      const claimToken = `finalize-claim-${id}-${it.id}`;
      await intentService.claimExecution(tx, { intentId: r.intentId, intentItemId: Number(it.id), claimToken }, actor);
      return intentService.markExecution(tx, {
        intentId: r.intentId, intentItemId: Number(it.id), claimToken, status: "SUCCESS",
        providerReference: it.providerReference,
      }, actor);
    });
  }
  return r.intentId;
}

async function entriesOf(invoiceId: number) {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.invoiceId, invoiceId));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
  seq = 0;
});

describe("ش٨ — البيع من مزوّد مسبق الدفع (§٦.٢)", () => {
  it("قيد SALE يحمل حصة المزوّد تكلفةً والهامش ربحاً؛ والمحفظة تُخصَم بقيد أصلٍ صفريّ", async () => {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, "كارت", walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "13400" }]);
    expect(priced.get(offeringId)!.price).toBe("14250.00"); // 13400 + 850

    const intentId = await prepareAndExecute([{ offeringId, priced: priced.get(offeringId)! }]);
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-0001-aaaa", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor));

    const entries = await entriesOf(res.invoiceId);
    const sale = entries.find((e) => e.entryType === "SALE")!;
    expect(sale.revenue).toBe("14250.00");
    expect(sale.cost).toBe("13400.00");
    expect(sale.profit).toBe("850.00");

    const cons = entries.find((e) => e.entryType === "DIGITAL_WALLET_CONSUMPTION")!;
    expect(cons.amount).toBe("13400.00");
    expect(cons.revenue).toBe("0.00");
    expect(cons.cost).toBe("0.00");
    expect(cons.profit).toBe("0.00");
    expect(Number(cons.digitalWalletId)).toBe(walletId);

    const [w] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(w.currentBalance).toBe("86600.00");  // 100000 − 13400
    expect(w.reservedBalance).toBe("0.00");     // استُهلك الحجز

    const [wt] = await db().select().from(s.digitalWalletTransactions);
    expect(wt.type).toBe("SALE_CONSUMPTION");
    expect(wt.direction).toBe("OUT");
    expect(wt.balanceAfter).toBe("86600.00");

    const [rsv] = await db().select().from(s.digitalWalletReservations);
    expect(rsv.status).toBe("CONSUMED");
  });

  it("تكلفة السطر تُقرأ من النيّة لا من costPrice (الذي يبقى صفراً)", async () => {
    const { providerId } = await mkProvider("آسياسيل", "PREPAID");
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, "كارت", walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "13400" }]);
    const intentId = await prepareAndExecute([{ offeringId, priced: priced.get(offeringId)! }]);
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-cost-001", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor));

    const [ii] = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, res.invoiceId));
    expect(ii.unitCost).toBe("13400.00");
    const [off] = await db().select().from(s.digitalOfferings).where(eq(s.digitalOfferings.id, offeringId));
    const [variant] = await db().select().from(s.productVariants).where(eq(s.productVariants.id, Number(off.variantId)));
    expect(variant.costPrice).toBe("0.00"); // لم يُمَسّ
  });
});

describe("ش٨ — البيع من مزوّد آجل (§٦.٣)", () => {
  it("قيد PURCHASE يتيم بصفر أثر P&L يرفع رصيد المورّد", async () => {
    const { providerId, supplierId } = await mkProvider("منصّة نجاح", "POSTPAID");
    const offeringId = await mkOffering(providerId, "اشتراك", null, true);
    const priced = await publish(providerId, [{ offeringId, providerShare: "80000" }]);

    const intentId = await prepareAndExecute([{
      offeringId, priced: priced.get(offeringId)!,
      student: { studentName: "مريم", studentPhone: "07701234567", guardianPhone: "07709998888", address: "بغداد", mode: "UPDATE_PROFILE" },
    }]);
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-post-001", paymentAmount: "80850.00", paymentMethod: "CASH",
    }, actor));

    const entries = await entriesOf(res.invoiceId);
    const ap = entries.find((e) => e.entryType === "PURCHASE")!;
    expect(ap.amount).toBe("80000.00");
    expect(ap.revenue).toBe("0.00");
    expect(ap.cost).toBe("0.00");
    expect(ap.profit).toBe("0.00");
    expect(Number(ap.supplierId)).toBe(supplierId);
    expect(ap.dedupeKey).toBe(`DIGITAL:AP:${res.invoiceId}:${providerId}`);

    const [sup] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId));
    expect(sup.currentBalance).toBe("80000.00");

    // لا حركة محفظة للآجل.
    expect((await db().select().from(s.digitalWalletTransactions)).length).toBe(0);
    // النظام يبيع الاشتراك ويحفظ لقطة الطالب فقط؛ لا ينشئ ملفاً أو عقد انتهاء/تجديد.
    expect((await db().select().from(s.studentProfiles)).length).toBe(0);
    expect((await db().select().from(s.digitalSubscriptionContracts)).length).toBe(0);
    const [detail] = await db().select().from(s.digitalSaleDetails).where(eq(s.digitalSaleDetails.invoiceId, res.invoiceId));
    expect(detail.studentNameSnapshot).toBe("مريم");
    expect(detail.studentPhoneSnapshot).toBe("+9647701234567");
    const [saleRow] = await subscriptionService.listSubscriptionSales(db(), { branchId: 1 });
    expect(saleRow.invoiceId).toBe(res.invoiceId);
    expect(saleRow.providerReference).toMatch(/^REF-FIN-/);
    expect(saleRow.studentName).toBe("مريم");
    expect(saleRow.studentPhone).toBe("+9647701234567");
  });

  it("كرتان لنفس المزوّد الآجل في فاتورة واحدة ⇒ استحقاق **واحد مجمَّع**", async () => {
    const { providerId, supplierId } = await mkProvider("منصّة", "POSTPAID");
    const a = await mkOffering(providerId, "اشتراك أ", null);
    const b = await mkOffering(providerId, "اشتراك ب", null);
    const priced = await publish(providerId, [
      { offeringId: a, providerShare: "80000" }, { offeringId: b, providerShare: "20000" },
    ]);
    const intentId = await prepareAndExecute([
      { offeringId: a, priced: priced.get(a)! }, { offeringId: b, priced: priced.get(b)! },
    ]);
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-agg-001", paymentAmount: "101700.00", paymentMethod: "CASH",
    }, actor));

    const ap = (await entriesOf(res.invoiceId)).filter((e) => e.entryType === "PURCHASE");
    expect(ap).toHaveLength(1);
    expect(ap[0].amount).toBe("100000.00");
    const [sup] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId));
    expect(sup.currentBalance).toBe("100000.00");
  });
});

describe("ش٨ — الحراسة والذرّية والidempotency", () => {
  async function readyIntent() {
    const { providerId } = await mkProvider(`مزوّد-${++seq}`, "PREPAID");
    const walletId = await mkWallet(providerId, "100000", `W${seq}`);
    const offeringId = await mkOffering(providerId, `كارت-${seq}`, walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "13400" }]);
    const intentId = await prepareAndExecute([{ offeringId, priced: priced.get(offeringId)! }]);
    return { intentId, walletId };
  }

  it("معيار خروج ش٨: فشلٌ بعد الفاتورة يُرجِع كل شيء — لا حالة وسطية", async () => {
    const { intentId, walletId } = await readyIntent();
    await expect(
      withTx(async (tx) => {
        await finalizeService.finalize(tx, {
          intentId, clientRequestId: "fin-rollback-1", paymentAmount: "14250.00", paymentMethod: "CASH",
        }, actor);
        throw new Error("فشل مُصطنع بعد التثبيت");
      }),
    ).rejects.toThrow(/فشل مُصطنع/);

    // لا فاتورة، لا قيود، لا تفاصيل، لا حركة محفظة — والحجز ما زال ACTIVE والنيّة EXECUTED.
    expect((await db().select().from(s.invoices)).length).toBe(0);
    expect((await db().select().from(s.accountingEntries)).length).toBe(0);
    expect((await db().select().from(s.digitalSaleDetails)).length).toBe(0);
    expect((await db().select().from(s.digitalWalletTransactions)).length).toBe(0);
    const [w] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(w.currentBalance).toBe("100000.00");
    expect(w.reservedBalance).toBe("13400.00");
    const [rsv] = await db().select().from(s.digitalWalletReservations);
    expect(rsv.status).toBe("ACTIVE");
    const [intent] = await db().select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id, intentId));
    expect(intent.status).toBe("EXECUTED");
    expect(intent.invoiceId).toBeNull();
  });

  it("إعادة التثبيت تُعيد الفاتورة نفسها بلا أثرٍ ثانٍ", async () => {
    const { intentId, walletId } = await readyIntent();
    const a = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-idem-001", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor));
    const b = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-idem-001", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor));

    expect(b.idempotentReplay).toBe(true);
    expect(b.invoiceId).toBe(a.invoiceId);
    expect((await db().select().from(s.invoices)).length).toBe(1);
    expect((await db().select().from(s.digitalWalletTransactions)).length).toBe(1);
    const [w] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
    expect(w.currentBalance).toBe("86600.00"); // خُصم مرّةً واحدة
  });

  it("نيّة لم تنجح كل كروتها لا تُثبَّت", async () => {
    const { providerId } = await mkProvider("مزوّد-ن", "PREPAID");
    const walletId = await mkWallet(providerId, "100000", "WN");
    const offeringId = await mkOffering(providerId, "كارت-ن", walletId);
    const priced = await publish(providerId, [{ offeringId, providerShare: "13400" }]);
    const r = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "prep-notdone-1", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fpX",
      lines: [{ lineKey: "lk1", offeringId, priceVersionId: priced.get(offeringId)!.pv, expectedSellPrice: priced.get(offeringId)!.price, providerReference: "REF-NOT-DONE" }],
    }, actor));

    await expect(withTx((tx) => finalizeService.finalize(tx, {
      intentId: r.intentId, clientRequestId: "fin-notdone-1", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor))).rejects.toThrow(/يجب أن تنجح كل الكروت/);
    expect((await db().select().from(s.invoices)).length).toBe(0);
  });

  it("مبلغ مقبوض مخالف للإجمالي مرفوض (لا بيع رقميّ جزئيّ)", async () => {
    const { intentId } = await readyIntent();
    await expect(withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-partial-1", paymentAmount: "10000.00", paymentMethod: "CASH",
    }, actor))).rejects.toThrow(/لا يطابق إجمالي الكروت/);
    expect((await db().select().from(s.invoices)).length).toBe(0);
  });

  it("ثابت §٥.١٠: Σ(حصة + ربح) = Σ(سعر البيع) وتفاصيل PREPAID تحمل حركة محفظة", async () => {
    const { intentId } = await readyIntent();
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-bal-0001", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor));

    expect(await finalizeService.assertDetailsBalanced(db(), res.invoiceId)).toBe(true);
    const details = await finalizeService.getSaleDetails(db(), res.invoiceId);
    expect(details).toHaveLength(1);
    expect(details[0].settlementMode).toBe("PREPAID");
    expect(details[0].walletTransactionId).not.toBeNull();
    expect(details[0].fulfillmentStatus).toBe("ISSUED");
    expect(details[0].providerReference).toMatch(/^REF-/);

    const [intent] = await db().select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id, intentId));
    expect(intent.status).toBe("FINALIZED");
    expect(Number(intent.invoiceId)).toBe(res.invoiceId);
  });

  it("الفاتورة تُقبض بالكامل ولا تترك ذمّة على العميل", async () => {
    const { intentId } = await readyIntent();
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-paid-0001", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor));
    const [inv] = await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId));
    expect(inv.total).toBe("14250.00");
    expect(inv.paidAmount).toBe("14250.00");
    const pay = (await entriesOf(res.invoiceId)).filter((e) => e.entryType === "PAYMENT_IN");
    expect(pay).toHaveLength(1);
    expect(pay[0].amount).toBe("14250.00");
  });

  it("ش١٠: حمولة الطباعة من الخادم بلا حصة مزوّد ولا ربح، وإعادة الطباعة تُعيدها نفسها", async () => {
    const { providerId } = await mkProvider("منصّة طباعة", "POSTPAID");
    const offeringId = await mkOffering(providerId, "اشتراك للطباعة", null, true);
    const priced = await publish(providerId, [{ offeringId, providerShare: "80000" }]);
    const intentId = await prepareAndExecute([{
      offeringId, priced: priced.get(offeringId)!,
      student: { studentName: "مريم عادل", studentPhone: "07713334444", guardianPhone: "07705556666", address: "بغداد — زيونة", mode: "UPDATE_PROFILE" },
    }]);
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-print-001", paymentAmount: "80850.00", paymentMethod: "CASH",
    }, actor));

    expect(res.printDetails).toHaveLength(1);
    const p = res.printDetails[0];
    expect(p.lineName).toBe("اشتراك للطباعة");
    expect(p.studentName).toBe("مريم عادل");
    expect(p.studentPhone).toBe("+9647713334444");
    expect(p.providerReference).toMatch(/^REF-/);
    // الحقول المالية الداخلية غائبة عن الحمولة أصلاً (§١٢.٢).
    const keys = Object.keys(p);
    for (const forbidden of ["providerShare", "providerShareSnapshot", "profit", "profitSnapshot", "sellPrice", "walletTransactionId"]) {
      expect(keys, `تسريب ${forbidden}`).not.toContain(forbidden);
    }
    expect(JSON.stringify(res.printDetails)).not.toContain("80000");

    // إعادة الطباعة تُعيد اللقطة ذاتها (§١٢.١-٤).
    const again = await finalizeService.reprintDetails(db(), res.invoiceId);
    expect(again).toEqual(res.printDetails);
  });

  it("لا حركة مخزون للكرت الرقميّ (منتج خدميّ)", async () => {
    const { intentId } = await readyIntent();
    const res = await withTx((tx) => finalizeService.finalize(tx, {
      intentId, clientRequestId: "fin-nostock-01", paymentAmount: "14250.00", paymentMethod: "CASH",
    }, actor));
    const mv = await db().select().from(s.inventoryMovements);
    expect(mv).toHaveLength(0);
    expect((await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, res.invoiceId))).length).toBe(1);
  });
});
