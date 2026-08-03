import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { intentService, offeringService, pricingService, providerService, walletService } from "../digitalCards";

/**
 * البطاقات الرقمية — ش٧: النيّة والتنفيذ الخارجيّ.
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §٥.٩ + §٨.٥ + §٩.٢.
 */

const actor = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "manager" };
const DATE = "2026-07-29";

const TABLES = [
  "digitalSaleIntentItems", "digitalWalletReservations", "digitalSaleIntents",
  "digitalPriceChangeReports", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWalletTransactions", "digitalWallets", "digitalProviders",
  "shifts", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "auditLogs", "studentProfiles", "customers", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

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

async function mkProvider(opts: { name?: string; settlementMode?: "PREPAID" | "POSTPAID"; referencePolicy?: "REQUIRED" | "OPTIONAL" | "NONE" } = {}) {
  const { supplierId } = await createSupplier({ name: opts.name ?? "آسياسيل" }, { userId: 1, branchId: 1 });
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(tx, {
      supplierId, providerType: "TELECOM",
      settlementMode: opts.settlementMode ?? "PREPAID",
      recognitionMode: "PRINCIPAL_GROSS",
      referencePolicy: opts.referencePolicy ?? "OPTIONAL",
      settlementCycle: "ON_DEMAND",
    }, { userId: 1, branchId: 1 }),
  );
  return providerId;
}

async function mkWallet(providerId: number, balance: string, branchId = 1, code = "W1") {
  const { walletId } = await withTx((tx) =>
    walletService.createWallet(tx, { providerId, branchId, code, name: `محفظة ${code}` }, { userId: 1, branchId: 1 }),
  );
  await db().update(s.digitalWallets).set({ currentBalance: balance }).where(eq(s.digitalWallets.id, walletId));
  return walletId;
}

async function mkOffering(providerId: number, opts: { name?: string; walletId?: number | null; edu?: boolean; branchId?: number } = {}) {
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId,
    offeringType: opts.edu ? "EDUCATIONAL_SUBSCRIPTION" : "TELECOM_CARD",
    name: opts.name ?? "كارت ١٠ آلاف",
    requiresStudentData: !!opts.edu,
    subscriptionDurationDays: opts.edu ? 30 : null,
    pricingMode: "FIXED_MARGIN",
    fixedMargin: "500",
    roundingStep: "250",
    branches: [{ branchId: opts.branchId ?? 1, walletId: opts.walletId ?? null }],
  }, { userId: 1, branchId: 1 }));
  return r.offeringId;
}

async function publish(branchId: number, providerId: number, lines: { offeringId: number; providerShare: string }[]) {
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(tx, { branchId, providerId, businessDate: DATE }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines }, { userId: 1, branchId: 1 }));
  await withTx((tx) => pricingService.publish(tx, { batchId }, { userId: 1, branchId: 1 }));
  const rows = await db().select({ offeringId: s.digitalCurrentPrices.offeringId, pv: s.digitalCurrentPrices.priceVersionId, price: s.digitalPriceVersions.sellPrice })
    .from(s.digitalCurrentPrices)
    .innerJoin(s.digitalPriceVersions, eq(s.digitalCurrentPrices.priceVersionId, s.digitalPriceVersions.id))
    .where(eq(s.digitalCurrentPrices.branchId, branchId));
  return new Map(rows.map((r) => [Number(r.offeringId), { pv: Number(r.pv), price: r.price }]));
}

function line(offeringId: number, priced: { pv: number; price: string }, over: Partial<intentService.PrepareLine> = {}): intentService.PrepareLine {
  return {
    lineKey: `lk-${offeringId}-${Math.random().toString(36).slice(2, 9)}`,
    offeringId,
    priceVersionId: priced.pv,
    expectedSellPrice: priced.price,
    ...over,
  };
}

async function wallet(walletId: number) {
  const [w] = await db().select().from(s.digitalWallets).where(eq(s.digitalWallets.id, walletId));
  return w;
}
async function intentRow(id: number) {
  const [i] = await db().select().from(s.digitalSaleIntents).where(eq(s.digitalSaleIntents.id, id));
  return i;
}
async function itemsOf(intentId: number) {
  return db().select().from(s.digitalSaleIntentItems).where(eq(s.digitalSaleIntentItems.intentId, intentId));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("ش٧ — الإعداد (prepare)", () => {
  it("يحجز الرصيد ولا يخفضه ولا يُنشئ فاتورة", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    const r = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-0001-aaaa", branchId: 1, shiftId: 1, paymentMethod: "CASH",
      cartFingerprint: "fp1", lines: [line(offeringId, priced.get(offeringId)!)],
    }, actor));

    const w = await wallet(walletId);
    expect(w.currentBalance).toBe("100000.00");   // لم يُخفَض
    expect(w.reservedBalance).toBe("9500.00");    // حُجز فقط
    expect((await intentRow(r.intentId)).status).toBe("PREPARED");
    expect((await intentRow(r.intentId)).invoiceId).toBeNull();
    expect((await db().select().from(s.invoices)).length).toBe(0);
    expect(await intentService.activeReservedTotal(db(), walletId)).toBe("9500.00");
  });

  it("النقر المزدوج بنفس clientRequestId يعيد النيّة نفسها بلا حجزٍ ثانٍ", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);
    const payload = {
      clientRequestId: "req-dup-1234", branchId: 1, shiftId: 1, paymentMethod: "CASH",
      cartFingerprint: "fp1", lines: [line(offeringId, priced.get(offeringId)!)],
    };

    const a = await withTx((tx) => intentService.prepare(tx, payload, actor));
    const b = await withTx((tx) => intentService.prepare(tx, payload, actor));
    expect(b.replay).toBe(true);
    expect(b.intentId).toBe(a.intentId);
    expect((await wallet(walletId)).reservedBalance).toBe("9500.00"); // حجزٌ واحد لا اثنان
  });

  it("نفس المفتاح بسلّةٍ مختلفة يُرفَض (لا خلط فواتير)", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);
    const base = { clientRequestId: "req-fp-9999", branchId: 1, shiftId: 1, paymentMethod: "CASH", lines: [line(offeringId, priced.get(offeringId)!)] };

    await withTx((tx) => intentService.prepare(tx, { ...base, cartFingerprint: "fpA" }, actor));
    await expect(withTx((tx) => intentService.prepare(tx, { ...base, cartFingerprint: "fpB" }, actor)))
      .rejects.toThrow(/سلّةٍ مختلفة/);
  });

  it("رصيد المحفظة لا يكفي ⇒ رفض بلا أثر", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "5000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-low-0001", branchId: 1, shiftId: 1, paymentMethod: "CASH",
      cartFingerprint: "fp", lines: [line(offeringId, priced.get(offeringId)!)],
    }, actor))).rejects.toThrow(/لا يكفي/);

    expect((await wallet(walletId)).reservedBalance).toBe("0.00");
    expect((await db().select().from(s.digitalSaleIntents)).length).toBe(0);
  });

  it("الكفاية تُحسب على المتاح (الرصيد − المحجوز) لا الرصيد وحده", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "15000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-a-0001", branchId: 1, shiftId: 1, paymentMethod: "CASH",
      cartFingerprint: "fpA", lines: [line(offeringId, priced.get(offeringId)!)],
    }, actor));
    // الرصيد ١٥٠٠٠ لكن المتاح ٥٥٠٠ ⇒ نيّة ثانية بـ٩٥٠٠ تُرفَض.
    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-b-0002", branchId: 1, shiftId: 1, paymentMethod: "CASH",
      cartFingerprint: "fpB", lines: [line(offeringId, priced.get(offeringId)!)],
    }, actor))).rejects.toThrow(/لا يكفي/);
  });

  it("يرفض سعراً منحرفاً عن الخادم وإصداراً غير نافذ", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-price-01", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [line(offeringId, priced.get(offeringId)!, { expectedSellPrice: "9000" })],
    }, actor))).rejects.toThrow(/لا يطابق سعر الخادم/);

    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-pv-01", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [line(offeringId, priced.get(offeringId)!, { priceVersionId: 999999 })],
    }, actor))).rejects.toThrow(/تغيّر سعر/);
  });

  it("يرفض الآجل ووردية مغلقة ومفاتيح أسطر مكرّرة", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "100000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);
    const l = line(offeringId, priced.get(offeringId)!);

    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-credit-1", branchId: 1, shiftId: 1, paymentMethod: "CREDIT", cartFingerprint: "fp", lines: [l],
    }, actor))).rejects.toThrow(/نقداً أو ببطاقة فقط/);

    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-dupkey-1", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [l, { ...l }],
    }, actor))).rejects.toThrow(/مفاتيح أسطر مكرّرة/);

    await db().update(s.shifts).set({ status: "CLOSED" }).where(eq(s.shifts.id, 1));
    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-shift-1", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp", lines: [l],
    }, actor))).rejects.toThrow(/لا وردية مفتوحة/);
  });

  it("الاشتراك التعليميّ يتطلّب بيانات الطالب، وغير التعليميّ يرفضها", async () => {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "100000");
    const tel = await mkOffering(providerId, { name: "كارت", walletId });
    const edu = await mkOffering(providerId, { name: "اشتراك", walletId, edu: true });
    const priced = await publish(1, providerId, [
      { offeringId: tel, providerShare: "9500" }, { offeringId: edu, providerShare: "9500" },
    ]);

    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-edu-miss", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [line(edu, priced.get(edu)!)],
    }, actor))).rejects.toThrow(/يتطلّب بيانات الطالب/);

    await expect(withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-tel-stud", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [line(tel, priced.get(tel)!, {
        student: { studentName: "ط", studentPhone: "07701234567", guardianPhone: "07709998888", address: "بغداد", mode: "UPDATE_PROFILE" },
      })],
    }, actor))).rejects.toThrow(/لا يقبل بيانات طالب/);

    const ok = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-edu-ok-1", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [line(edu, priced.get(edu)!, {
        student: { studentName: "مريم", studentPhone: "07701234567", guardianPhone: "07709998888", address: "بغداد", mode: "UPDATE_PROFILE" },
      })],
    }, actor));
    const its = await itemsOf(ok.intentId);
    expect(its[0].studentNameSnapshot).toBe("مريم");
    expect(its[0].studentPhoneSnapshot).toBe("+9647701234567");
    // لا كتابة في ملفّات الطلاب عند الإعداد — التثبيت لاحقاً.
    expect((await db().select().from(s.studentProfiles)).length).toBe(0);
  });

  it("المزوّد الآجل (POSTPAID) لا يحتاج محفظة ولا يحجز", async () => {
    const providerId = await mkProvider({ name: "زين", settlementMode: "POSTPAID" });
    const offeringId = await mkOffering(providerId);
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    const r = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: "req-post-001", branchId: 1, shiftId: 1, paymentMethod: "CASH", cartFingerprint: "fp",
      lines: [line(offeringId, priced.get(offeringId)!)],
    }, actor));
    expect((await db().select().from(s.digitalWalletReservations)).length).toBe(0);
    expect((await intentRow(r.intentId)).status).toBe("PREPARED");
  });
});

describe("ش٧ — تسجيل التنفيذ", () => {
  async function prepared(opts: { referencePolicy?: "REQUIRED" | "OPTIONAL" | "NONE"; count?: number } = {}) {
    const providerId = await mkProvider({ referencePolicy: opts.referencePolicy });
    const walletId = await mkWallet(providerId, "500000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);
    const lines = Array.from({ length: opts.count ?? 1 }, () => line(offeringId, priced.get(offeringId)!));
    const r = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: `req-${Math.random().toString(36).slice(2, 12)}`, branchId: 1, shiftId: 1,
      paymentMethod: "CASH", cartFingerprint: "fp", lines,
    }, actor));
    return { ...r, walletId, offeringId, items: await itemsOf(r.intentId) };
  }

  it("تسجيل النجاح يثبت الحالة والمرجع، وكل البنود ⇒ EXECUTED", async () => {
    const p = await prepared({ count: 2 });
    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS", providerReference: "REF-1",
    }, actor));
    expect((await intentRow(p.intentId)).status).toBe("EXECUTING");

    const res = await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[1].id), status: "SUCCESS", providerReference: "REF-2",
    }, actor));
    expect(res.allSettled).toBe(true);
    expect((await intentRow(p.intentId)).status).toBe("EXECUTED");
  });

  it("النقر المزدوج على «نجح» يمرّ مرّةً واحدة (idempotent)", async () => {
    const p = await prepared();
    const payload = { intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS" as const, providerReference: "REF-X" };
    const a = await withTx((tx) => intentService.markExecution(tx, payload, actor));
    const b = await withTx((tx) => intentService.markExecution(tx, payload, actor));
    expect(a.idempotent).toBe(false);
    expect(b.idempotent).toBe(true);
    expect((await itemsOf(p.intentId))[0].providerReference).toBe("REF-X");
  });

  it("قيد القاعدة يمنع تكرار المرجع لدى المزوّد نفسه", async () => {
    const p = await prepared({ count: 2 });
    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS", providerReference: "SAME-REF",
    }, actor));
    await expect(withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[1].id), status: "SUCCESS", providerReference: "SAME-REF",
    }, actor))).rejects.toThrow(/مسجَّل لكرتٍ آخر/);
  });

  it("سياسة المرجع: REQUIRED تفرضه وNONE ترفضه", async () => {
    const req = await prepared({ referencePolicy: "REQUIRED" });
    await expect(withTx((tx) => intentService.markExecution(tx, {
      intentId: req.intentId, intentItemId: Number(req.items[0].id), status: "SUCCESS", providerReference: null,
    }, actor))).rejects.toThrow(/يتطلّب رقم مرجع/);

    const none = await prepared({ referencePolicy: "NONE" });
    await expect(withTx((tx) => intentService.markExecution(tx, {
      intentId: none.intentId, intentItemId: Number(none.items[0].id), status: "SUCCESS", providerReference: "R",
    }, actor))).rejects.toThrow(/لا يستعمل مرجع/);
  });

  it("الكاشير لا يتراجع عن نجاحٍ سُجِّل؛ المدير يستطيع", async () => {
    const p = await prepared();
    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS", providerReference: "REF-Z",
    }, actor));
    await expect(withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "FAILED", providerReference: null,
    }, actor))).rejects.toThrow(/لا يُلغى نجاحُ كرتٍ صدر فعلاً/);

    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "FAILED", providerReference: null,
    }, manager));
    expect((await itemsOf(p.intentId))[0].fulfillmentStatus).toBe("FAILED");
  });

  it("فشل/عدم تأكيد أيّ بند ⇒ النيّة NEEDS_REVIEW لا EXECUTED", async () => {
    const p = await prepared({ count: 2 });
    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS", providerReference: "OK-1",
    }, actor));
    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[1].id), status: "UNKNOWN", providerReference: null,
    }, actor));
    expect((await intentRow(p.intentId)).status).toBe("NEEDS_REVIEW");
  });

  it("نيّة مستخدم آخر محجوبة عن الكاشير ومتاحة للمدير", async () => {
    const p = await prepared();
    const other = { userId: 99, branchId: 1, role: "cashier" };
    await db().insert(s.users).values({ id: 99, openId: "u99", name: "كاشير آخر", role: "cashier", loginMethod: "local" });
    await expect(withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS", providerReference: "R-9",
    }, other))).rejects.toThrow(/لمستخدم آخر/);

    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS", providerReference: "R-9",
    }, manager));
    expect((await itemsOf(p.intentId))[0].fulfillmentStatus).toBe("SUCCESS");
  });
});

describe("ش٧ — الإلغاء والانتهاء وطابور المراجعة", () => {
  async function prepared(count = 1) {
    const providerId = await mkProvider();
    const walletId = await mkWallet(providerId, "500000");
    const offeringId = await mkOffering(providerId, { walletId });
    const priced = await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);
    const lines = Array.from({ length: count }, () => line(offeringId, priced.get(offeringId)!));
    const r = await withTx((tx) => intentService.prepare(tx, {
      clientRequestId: `req-${Math.random().toString(36).slice(2, 12)}`, branchId: 1, shiftId: 1,
      paymentMethod: "CASH", cartFingerprint: "fp", lines,
    }, actor));
    return { ...r, walletId, items: await itemsOf(r.intentId) };
  }

  it("إلغاء قبل أي تنفيذ يحرّر الحجز كاملاً", async () => {
    const p = await prepared();
    expect((await wallet(p.walletId)).reservedBalance).toBe("9500.00");
    const res = await withTx((tx) => intentService.cancelIntent(tx, { intentId: p.intentId }, actor));
    expect(res.outcome).toBe("CANCELLED");
    expect((await wallet(p.walletId)).reservedBalance).toBe("0.00");
    expect((await intentRow(p.intentId)).status).toBe("CANCELLED");
  });

  it("معيار خروج ش٧: كرتٌ نُفِّذ لا يُلغى ولا يُحرَّر حجزه — ينتقل للمراجعة", async () => {
    const p = await prepared(2);
    await withTx((tx) => intentService.markExecution(tx, {
      intentId: p.intentId, intentItemId: Number(p.items[0].id), status: "SUCCESS", providerReference: "ISSUED-1",
    }, actor));

    const res = await withTx((tx) => intentService.cancelIntent(tx, { intentId: p.intentId, reason: "أغلق المتصفّح" }, actor));
    expect(res.outcome).toBe("NEEDS_REVIEW");
    expect((await intentRow(p.intentId)).status).toBe("NEEDS_REVIEW");
    // الحجز **باقٍ كاملاً** (كرتان × ٩٥٠٠): للكرت الصادر أثرٌ ماليّ مستحقّ لا يُمحى،
    // ولا يُفكّ الحجز جزئياً هنا — التسوية قرارٌ إداريّ في المراجعة.
    expect((await wallet(p.walletId)).reservedBalance).toBe("19000.00");
    // والكرت الصادر ما زال مسجَّلاً بمرجعه — قابلٌ للاسترداد الإداريّ.
    const items = await itemsOf(p.intentId);
    expect(items.find((i) => i.fulfillmentStatus === "SUCCESS")?.providerReference).toBe("ISSUED-1");

    const queue = await intentService.listNeedsReview(db(), { branchId: 1 });
    expect(queue).toHaveLength(1);
    expect(Number(queue[0].successCount)).toBe(1);
    expect(Number(queue[0].itemCount)).toBe(2);
  });

  it("الكنّاس: نيّة مهجورة بلا تنفيذ ⇒ EXPIRED وتحرير، وبتنفيذٍ ⇒ NEEDS_REVIEW بلا تحرير", async () => {
    const clean = await prepared();
    const dirty = await prepared();
    await withTx((tx) => intentService.markExecution(tx, {
      intentId: dirty.intentId, intentItemId: Number(dirty.items[0].id), status: "SUCCESS", providerReference: "REF-D",
    }, actor));

    const past = new Date(Date.now() - 60_000);
    await db().update(s.digitalSaleIntents).set({ expiresAt: past });

    const res = await withTx((tx) => intentService.expireStaleIntents(tx, new Date()));
    expect(res.expired).toBe(1);
    expect(res.needsReview).toBe(1);
    expect((await intentRow(clean.intentId)).status).toBe("EXPIRED");
    expect((await intentRow(dirty.intentId)).status).toBe("NEEDS_REVIEW");
    // محفظة النيّة النظيفة تحرّرت، ومحفظة المنفَّذة بقيت محجوزة.
    expect(await intentService.activeReservedTotal(db(), clean.walletId)).toBe("0.00");
    expect(await intentService.activeReservedTotal(db(), dirty.walletId)).toBe("9500.00");
  });

  it("تحرير مزدوج لا يُنتج رصيداً محجوزاً سالباً", async () => {
    const p = await prepared();
    await withTx((tx) => intentService.cancelIntent(tx, { intentId: p.intentId }, actor));
    await withTx((tx) => intentService.cancelIntent(tx, { intentId: p.intentId }, actor));
    const w = await wallet(p.walletId);
    expect(w.reservedBalance).toBe("0.00");
    expect(Number(w.reservedBalance)).toBeGreaterThanOrEqual(0);
  });
});
