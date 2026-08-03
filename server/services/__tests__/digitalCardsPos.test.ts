import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { offeringService, posCardsService, pricingService, providerService } from "../digitalCards";

/**
 * البطاقات الرقمية — ش٥: شبكة بطاقات نقطة البيع.
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §٨.٢ + §٩.١.
 */

const actor = { userId: 1, branchId: 1 };
const DATE = "2026-07-29";

const TABLES = [
  "digitalPriceChangeReports", "digitalCurrentPrices", "digitalPriceVersions", "digitalPriceBatches",
  "digitalOfferingBranches", "digitalOfferings", "digitalWallets", "digitalProviders",
  "productPrices", "productUnitBarcodes", "productUnits", "productVariants", "productImages", "products",
  "auditLogs", "suppliers", "categories", "users", "branches",
];

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set for tests"); return d; }

async function seedBase() {
  await db().insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
}

async function mkProvider(name = "آسياسيل") {
  const { supplierId } = await createSupplier({ name }, actor);
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(tx, {
      supplierId, providerType: "TELECOM", settlementMode: "PREPAID",
      recognitionMode: "PRINCIPAL_GROSS", referencePolicy: "OPTIONAL", settlementCycle: "ON_DEMAND",
    }, actor),
  );
  return providerId;
}

async function mkOffering(providerId: number, over: {
  name?: string; offeringType?: string; requiresStudentData?: boolean;
  fixedMargin?: string; priceValidityHours?: number | null; branchIds?: number[]; favoriteAt?: number;
  subscriptionDurationDays?: number | null;
} = {}) {
  const r = await withTx((tx) => offeringService.createOffering(tx, {
    providerId,
    offeringType: over.offeringType ?? "TELECOM_CARD",
    name: over.name ?? "كارت ١٠ آلاف",
    requiresStudentData: over.requiresStudentData ?? false,
    subscriptionDurationDays:
      over.offeringType === "EDUCATIONAL_SUBSCRIPTION"
        ? over.subscriptionDurationDays ?? 30
        : null,
    pricingMode: "FIXED_MARGIN",
    fixedMargin: over.fixedMargin ?? "500",
    roundingStep: "250",
    priceValidityHours: over.priceValidityHours ?? null,
    branches: (over.branchIds ?? [1]).map((branchId) => ({
      branchId, isFavorite: over.favoriteAt === branchId,
    })),
  }, actor));
  return r.offeringId;
}

async function publish(branchId: number, providerId: number, lines: { offeringId: number; providerShare: string }[], date = DATE) {
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(tx, { branchId, providerId, businessDate: date }, actor));
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines }, actor));
  return withTx((tx) => pricingService.publish(tx, { batchId }, actor));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("ش٥ — عقد الأمان: لا تكلفة ولا هامش ولا رصيد في مخرَج الكاشير", () => {
  it("المخرَج يحمل السعر فقط، وكلّ حقول التكلفة غائبة عن الكائن نفسه", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    const [card] = await posCardsService.listCards(db(), { branchId: 1 });
    expect(card.sellPrice).toBe("10000.00");

    const keys = Object.keys(card);
    const forbidden = [
      "providerShare", "costPrice", "cost", "marginAmount", "margin",
      "fixedMargin", "marginPercent", "minimumMargin",
      "currentBalance", "reservedBalance", "settlementMode", "lowBalanceThreshold",
    ];
    for (const k of forbidden) expect(keys, `تسريب حقل ${k}`).not.toContain(k);

    // فحصٌ ثانٍ على القيم نفسها: لا قيمة تساوي حصة المزوّد المخزَّنة.
    expect(JSON.stringify(card)).not.toContain("9500");
  });
});

describe("ش٥ — الجاهزية", () => {
  it("بطاقة بلا سعر منشور ⇒ NO_PRICE ولا يمكن تأكيدها", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);

    const [card] = await posCardsService.listCards(db(), { branchId: 1 });
    expect(card.availability).toBe("NO_PRICE");
    expect(card.sellPrice).toBeNull();

    await expect(posCardsService.confirmCard(db(), { branchId: 1, offeringId }))
      .rejects.toThrow(/بلا سعر منشور/);
  });

  it("نشر السعر يجعلها READY فوراً وقابلةً للتأكيد بسعر الخادم", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    const [card] = await posCardsService.listCards(db(), { branchId: 1 });
    expect(card.availability).toBe("READY");

    const confirmed = await posCardsService.confirmCard(db(), { branchId: 1, offeringId });
    expect(confirmed.sellPrice).toBe("10000.00");
    expect(confirmed.priceVersionId).toBe(card.priceVersionId);
  });

  it("تجاوز مدّة صلاحية السعر ⇒ STALE_PRICE ويُرفض التأكيد", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId, { priceValidityHours: 12 });
    await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);

    const fresh = await posCardsService.listCards(db(), { branchId: 1 });
    expect(fresh[0].availability).toBe("READY");

    // بعد ١٣ ساعة من السريان.
    const later = new Date(Date.now() + 13 * 3_600_000);
    const stale = await posCardsService.listCards(db(), { branchId: 1, now: later });
    expect(stale[0].availability).toBe("STALE_PRICE");

    // التأكيد يستعمل الزمن الحقيقيّ ⇒ ما زال جاهزاً الآن؛ نُثبت الرفض بختم انتهاء صريح.
    await db().update(s.digitalPriceVersions)
      .set({ validUntil: new Date() })
      .where(eq(s.digitalPriceVersions.id, Number(fresh[0].priceVersionId)));
    await expect(posCardsService.confirmCard(db(), { branchId: 1, offeringId }))
      .rejects.toThrow(/انتهت صلاحيته/);
  });

  it("بطاقة معطَّلة أو مزوّد معطَّل لا تظهر في الشبكة إطلاقاً", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, { name: "كارت أ" });
    const b = await mkOffering(providerId, { name: "كارت ب" });
    await publish(1, providerId, [
      { offeringId: a, providerShare: "9500" },
      { offeringId: b, providerShare: "4500" },
    ]);
    expect(await posCardsService.listCards(db(), { branchId: 1 })).toHaveLength(2);

    await withTx((tx) => offeringService.updateOffering(tx, { id: b, isActive: false }, actor));
    expect((await posCardsService.listCards(db(), { branchId: 1 })).map((c) => c.name)).toEqual(["كارت أ"]);

    await withTx((tx) => providerService.updateProvider(tx, { id: providerId, isActive: false }, actor));
    expect(await posCardsService.listCards(db(), { branchId: 1 })).toHaveLength(0);
  });
});

describe("ش٥ — العزل والتصفية", () => {
  it("بطاقة فرعٍ آخر لا تظهر لهذا الفرع", async () => {
    const providerId = await mkProvider();
    const only2 = await mkOffering(providerId, { name: "خاصّ بفرع المبيعات", branchIds: [2] });
    await publish(2, providerId, [{ offeringId: only2, providerShare: "9500" }]);

    expect(await posCardsService.listCards(db(), { branchId: 1 })).toHaveLength(0);
    expect(await posCardsService.listCards(db(), { branchId: 2 })).toHaveLength(1);
    await expect(posCardsService.confirmCard(db(), { branchId: 1, offeringId: only2 }))
      .rejects.toThrow(/غير متاحة في هذا الفرع/);
  });

  it("السعر لكل فرع مستقلّ في الشبكة", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId, { branchIds: [1, 2] });
    await publish(1, providerId, [{ offeringId, providerShare: "9500" }]);
    await publish(2, providerId, [{ offeringId, providerShare: "9750" }]);

    expect((await posCardsService.listCards(db(), { branchId: 1 }))[0].sellPrice).toBe("10000.00");
    expect((await posCardsService.listCards(db(), { branchId: 2 }))[0].sellPrice).toBe("10250.00");
  });

  it("تبويبات الفئات تُصفّي بالنوع، والمفضّلة بعلامة الفرع", async () => {
    const providerId = await mkProvider();
    const tel = await mkOffering(providerId, { name: "كارت اتصالات", offeringType: "TELECOM_CARD", favoriteAt: 1 });
    const glob = await mkOffering(providerId, { name: "بطاقة جوجل بلاي", offeringType: "GLOBAL_CARD" });
    const edu = await mkOffering(providerId, { name: "اشتراك منصّة", offeringType: "EDUCATIONAL_SUBSCRIPTION", requiresStudentData: true });
    await publish(1, providerId, [
      { offeringId: tel, providerShare: "9500" },
      { offeringId: glob, providerShare: "9500" },
      { offeringId: edu, providerShare: "9500" },
    ]);

    const byType = async (category: "TELECOM" | "GLOBAL" | "EDUCATIONAL" | "FAVORITES" | "ALL") =>
      (await posCardsService.listCards(db(), { branchId: 1, category })).map((c) => c.name);

    expect(await byType("TELECOM")).toEqual(["كارت اتصالات"]);
    expect(await byType("GLOBAL")).toEqual(["بطاقة جوجل بلاي"]);
    expect(await byType("EDUCATIONAL")).toEqual(["اشتراك منصّة"]);
    expect(await byType("FAVORITES")).toEqual(["كارت اتصالات"]);
    expect(await byType("ALL")).toHaveLength(3);

    const eduCard = (await posCardsService.listCards(db(), { branchId: 1, category: "EDUCATIONAL" }))[0];
    expect(eduCard.requiresStudentData).toBe(true);
  });

  it("البحث يطابق اسم البطاقة واسم المزوّد ويتسامح مع الهمزات والأرقام الهندية", async () => {
    const providerId = await mkProvider("آسياسيل");
    const a = await mkOffering(providerId, { name: "كارت اسياسيل ١٠ آلاف" });
    const b = await mkOffering(providerId, { name: "بطاقة جوجل بلاي" });
    await publish(1, providerId, [
      { offeringId: a, providerShare: "9500" },
      { offeringId: b, providerShare: "9500" },
    ]);

    const names = async (q: string) => (await posCardsService.listCards(db(), { branchId: 1, q })).map((c) => c.name);
    expect(await names("جوجل")).toEqual(["بطاقة جوجل بلاي"]);
    expect(await names("آسياسيل")).toHaveLength(2); // الاسم + المزوّد
    expect(await names("10")).toEqual(["كارت اسياسيل ١٠ آلاف"]); // ١٠ الهندية ⇒ 10
    expect(await names("لا يوجد")).toHaveLength(0);
  });

  it("ترتيب العرض يتبع displayOrder للفرع", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, { name: "كارت أ" });
    const b = await mkOffering(providerId, { name: "كارت ب" });
    await publish(1, providerId, [
      { offeringId: a, providerShare: "9500" },
      { offeringId: b, providerShare: "9500" },
    ]);
    await withTx((tx) => offeringService.reorderOfferings(tx, {
      branchId: 1, order: [{ offeringId: b, displayOrder: 1 }, { offeringId: a, displayOrder: 2 }],
    }, actor));

    expect((await posCardsService.listCards(db(), { branchId: 1 })).map((c) => c.name)).toEqual(["كارت ب", "كارت أ"]);
  });

  it("فرع غير موجود يعيد قائمة فارغة لا خطأً", async () => {
    expect(await posCardsService.listCards(db(), { branchId: 999999 })).toHaveLength(0);
  });
});
