import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { offeringService, pricingService, providerService } from "../digitalCards";

/**
 * البطاقات الرقمية §٧.١ — «التغيير الكبير» (عتبة المالك: ٥٠٪).
 *
 * الثوابت المحروسة:
 *   B1 — تغيّرٌ <٥٠٪ يُنشَر بلا اعتمادٍ ثانٍ (لا نُعطّل العمل اليوميّ).
 *   B2 — تغيّرٌ ≥٥٠٪ يوقف النشر حتى يعتمده مديرٌ آخر.
 *   B3 — SOD: لا يعتمد مُنشئ المسودّة (admin مُستثنى).
 *   B4 — **تعديل المسودّة بعد الاعتماد يُبطله** — لا يُعتمَد سعرٌ ثمّ يُنشَر غيره.
 *        ويشمل ذلك `copyPrevious` لا `saveDraft` وحده.
 *   B5 — بلا سعرٍ نافذ (أوّل تسعير) ليس تغييراً كبيراً؛ والحصة النافذة صفر تُعدّ كبيرة.
 *   B6 — العتبة حدّيّة: ٥٠٪ بالضبط تُوقِف، و٤٩.٩٩٪ تمرّ.
 */

const mgrA = { userId: 2, branchId: 1, role: "manager" };
const mgrB = { userId: 3, branchId: 1, role: "manager" };
const admin = { userId: 4, branchId: 1, role: "admin" };

const TABLES = [
  "digitalSaleExecutionClaims", "digitalSaleIntentItems", "digitalWalletReservations", "digitalSaleIntents",
  "digitalPriceChangeReports", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWalletTransactions", "digitalWallets", "digitalProviders",
  "accountingEntries", "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "products",
  "auditLogs", "customers", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([
    { id: 2, openId: "u2", name: "مدير أ", role: "manager", loginMethod: "local" },
    { id: 3, openId: "u3", name: "مدير ب", role: "manager", loginMethod: "local" },
    { id: 4, openId: "u4", name: "أدمن", role: "admin", loginMethod: "local" },
  ]);
}

async function mkProvider() {
  const { supplierId } = await createSupplier({ name: "آسياسيل" }, mgrA);
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(tx, {
      supplierId, providerType: "TELECOM", settlementMode: "POSTPAID",
      recognitionMode: "PRINCIPAL_GROSS", referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
    }, mgrA),
  );
  return providerId;
}

async function mkOffering(providerId: number, name = "كارت ١٠ آلاف") {
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId, offeringType: "TELECOM_CARD", name,
    pricingMode: "FIXED_MARGIN", fixedMargin: "500", roundingStep: "250",
    branches: [{ branchId: 1, walletId: null }],
  }, mgrA));
  return r.offeringId;
}

/** يُنشئ مسودّة بحصصٍ معطاة ويعيد رقمها (بلا نشر). */
async function draft(
  providerId: number,
  date: string,
  lines: { offeringId: number; providerShare: string; sellPrice?: string }[],
  actor = mgrA,
) {
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: date }, actor));
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines }, actor));
  return batchId;
}

async function publishNow(
  providerId: number,
  date: string,
  lines: { offeringId: number; providerShare: string; sellPrice?: string }[],
  actor = mgrA,
) {
  const batchId = await draft(providerId, date, lines, actor);
  await withTx((tx) => pricingService.publish(tx, { batchId }, actor));
  return batchId;
}

async function batchRow(id: number) {
  const [b] = await db().select().from(s.digitalPriceBatches).where(eq(s.digitalPriceBatches.id, id));
  return b;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("§٧.١ — كشف التغيير الكبير", () => {
  it("B5: أوّل تسعير (بلا سعرٍ نافذ) ليس تغييراً كبيراً — يُنشَر مباشرةً", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);

    const batchId = await draft(providerId, "2026-07-30", [{ offeringId, providerShare: "9000" }]);
    const sheet = await pricingService.getMorningSheet(db(), { branchId: 1, providerId, businessDate: "2026-07-30" });
    expect(sheet.bigChanges).toHaveLength(0);

    await expect(withTx((tx) => pricingService.publish(tx, { batchId }, mgrA))).resolves.toBeTruthy();
  });

  it("B1: تغيّرٌ دون العتبة يُنشَر بلا اعتمادٍ ثانٍ", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);

    // 10000 → 14000 = ٤٠٪
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "14000" }]);
    const sheet = await pricingService.getMorningSheet(db(), { branchId: 1, providerId, businessDate: "2026-07-31" });
    expect(sheet.bigChanges).toHaveLength(0);
    await expect(withTx((tx) => pricingService.publish(tx, { batchId }, mgrA))).resolves.toBeTruthy();
  });

  it("B6: العتبة حدّيّة — ٥٠٪ بالضبط تُوقِف و٤٩.٩٪ تمرّ", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, "كارت أ");
    await publishNow(providerId, "2026-07-30", [{ offeringId: a, providerShare: "10000" }]);

    // 10000 → 14990 = ٤٩.٩٪ ⇒ تمرّ
    const pass = await draft(providerId, "2026-07-31", [{ offeringId: a, providerShare: "14990" }]);
    await expect(withTx((tx) => pricingService.publish(tx, { batchId: pass }, mgrA))).resolves.toBeTruthy();

    // 14990 → 22485 = ٥٠٪ بالضبط ⇒ تُوقِف
    const block = await draft(providerId, "2026-08-01", [{ offeringId: a, providerShare: "22485" }]);
    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId: block }, mgrA)),
    ).rejects.toThrow(/يلزم اعتماد مديرٍ آخر/);
  });

  it("B5: الحصة النافذة صفر وجديدُها موجب ⇒ تُعدّ تغييراً كبيراً", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "0" }]);

    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "5000" }]);
    const sheet = await pricingService.getMorningSheet(db(), { branchId: 1, providerId, businessDate: "2026-07-31" });
    expect(sheet.bigChanges).toHaveLength(1);
    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, mgrA)),
    ).rejects.toThrow(/يلزم اعتماد مديرٍ آخر/);
  });

  it("الانخفاض الكبير يُوقِف أيضاً (النسبة مطلقة لا اتجاهية)", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);

    // 10000 → 4000 = انخفاض ٦٠٪
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "4000" }]);
    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, mgrA)),
    ).rejects.toThrow(/يلزم اعتماد مديرٍ آخر/);
  });
});

describe("§٧.١ — الاعتماد وفصل المهام", () => {
  it("B2 + B3: مديرٌ آخر يعتمد فيُنشَر، ومُنشئ المسودّة لا يعتمد", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "20000" }], mgrA);

    // مُنشئ المسودّة (mgrA) لا يعتمد
    await expect(
      withTx((tx) => pricingService.approveBigChange(tx, { batchId }, mgrA)),
    ).rejects.toThrow(/مديرٌ آخر/);

    const r = await withTx((tx) => pricingService.approveBigChange(tx, { batchId }, mgrB));
    expect(r.approved).toHaveLength(1);
    expect(r.approved[0].changePercent).toBe("100.00");
    expect(Number((await batchRow(batchId)).bigChangeApprovedBy)).toBe(mgrB.userId);

    await expect(withTx((tx) => pricingService.publish(tx, { batchId }, mgrA))).resolves.toBeTruthy();
  });

  it("B3: لا استثناء للأدمن — لا يعتمد مسودّته المالية بنفسه", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "20000" }], admin);

    await expect(
      withTx((tx) => pricingService.approveBigChange(tx, { batchId }, admin)),
    ).rejects.toThrow(/مديرٌ آخر/);
  });

  it("الاعتماد بلا تغييرٍ كبير مرفوض", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "11000" }]);

    await expect(
      withTx((tx) => pricingService.approveBigChange(tx, { batchId }, mgrB)),
    ).rejects.toThrow(/لا تغييرات كبيرة/);
  });

  it("تغيّر سعر البيع الكبير مع ثبات التكلفة يحتاج اعتماداً ثانياً", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-08-01", [{ offeringId, providerShare: "100", sellPrice: "750" }]);
    const batchId = await draft(providerId, "2026-08-02", [
      { offeringId, providerShare: "100", sellPrice: "1500" },
    ]);

    await expect(withTx((tx) => pricingService.publish(tx, { batchId }, mgrA))).rejects.toThrow(/اعتماد مدير/);
  });

  it("آخر محرر للتغيير لا يستطيع اعتماد عمله ولو لم ينشئ الدفعة", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-08-01", [{ offeringId, providerShare: "100" }]);
    const batchId = await draft(providerId, "2026-08-02", [{ offeringId, providerShare: "160" }], mgrA);
    await withTx((tx) =>
      pricingService.saveDraft(tx, { batchId, lines: [{ offeringId, providerShare: "200" }] }, mgrB),
    );

    await expect(
      withTx((tx) => pricingService.approveBigChange(tx, { batchId }, mgrB)),
    ).rejects.toThrow(/حرّرتَه بنفسك/);
  });

  it("تغيّر baseline بعد الاعتماد يبطل بصمته ولو بقيت المسودة نفسها", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-08-01", [{ offeringId, providerShare: "100" }]);

    const staleApproved = await draft(
      providerId,
      "2026-08-03",
      [{ offeringId, providerShare: "160" }],
      mgrA,
    );
    await withTx((tx) => pricingService.approveBigChange(tx, { batchId: staleApproved }, mgrB));

    const intervening = await draft(
      providerId,
      "2026-08-02",
      [{ offeringId, providerShare: "10" }],
      mgrB,
    );
    await withTx((tx) => pricingService.approveBigChange(tx, { batchId: intervening }, mgrA));
    await withTx((tx) => pricingService.publish(tx, { batchId: intervening }, mgrB));

    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId: staleApproved }, mgrA)),
    ).rejects.toThrow(/تغيّر السعر النافذ/);
  });
});

describe("§٧.١ — إبطال الاعتماد عند التعديل (منع الالتفاف)", () => {
  it("B4: `saveDraft` بعد الاعتماد يُبطله ⇒ لا يُنشَر غير المعتمَد", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "20000" }], mgrA);

    await withTx((tx) => pricingService.approveBigChange(tx, { batchId }, mgrB));
    expect((await batchRow(batchId)).bigChangeApprovedBy).not.toBeNull();

    // تعديلٌ إلى رقمٍ أكبر بكثير — لو نجا الاعتماد لمرّ سعرٌ لم يره أحد.
    await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines: [{ offeringId, providerShare: "90000" }] }, mgrA));
    expect((await batchRow(batchId)).bigChangeApprovedBy).toBeNull();

    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, mgrA)),
    ).rejects.toThrow(/يلزم اعتماد مديرٍ آخر/);
  });

  it("B4: إعادة حفظٍ **مطابقة** لا تُبطل الاعتماد — وإلا استحال النشر", async () => {
    // نقطة النهاية `pricing.publish` تحفظ السطور ثمّ تنشر في المعاملة نفسها؛ لو أبطل كلُّ
    // حفظٍ الاعتمادَ لأُبطِل لحظةَ استعماله فما نُشر شيءٌ أبداً. (أمسكته الجولة البصرية.)
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "20000" }], mgrA);

    await withTx((tx) => pricingService.approveBigChange(tx, { batchId }, mgrB));

    // نفس القيمة بصيغةٍ مختلفة — المقارنة بـdecimal لا بالنصّ.
    await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines: [{ offeringId, providerShare: "20000.00" }] }, mgrA));
    expect((await batchRow(batchId)).bigChangeApprovedBy).not.toBeNull();

    await expect(withTx((tx) => pricingService.publish(tx, { batchId }, mgrA))).resolves.toBeTruthy();
  });

  it("B4: `copyPrevious` بعد الاعتماد يُبطله كذلك", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishNow(providerId, "2026-07-30", [{ offeringId, providerShare: "10000" }]);
    const batchId = await draft(providerId, "2026-07-31", [{ offeringId, providerShare: "20000" }], mgrA);

    await withTx((tx) => pricingService.approveBigChange(tx, { batchId }, mgrB));
    await withTx((tx) => pricingService.copyPrevious(tx, { branchId: 1, providerId, businessDate: "2026-07-31" }, mgrA));
    expect((await batchRow(batchId)).bigChangeApprovedBy).toBeNull();
  });
});
