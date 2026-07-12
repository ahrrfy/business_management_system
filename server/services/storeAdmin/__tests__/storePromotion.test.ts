/**
 * اختبارات storePromotionService — «العروض» في لوحة hPanel.
 * يغطّي: فرض RETAIL+فرع المتجر+isStoreManaged عند الإنشاء، تصفية القائمة، liveNow، وملكية القناة
 * (storeOwned = isStoreManaged) — مع منع IDOR عبر القنوات في التعطيل (لا يُعطَّل عرض كاشير RETAIL@فرع
 * المتجر رغم تطابق branch+tier)، وعزل عرض المتجر عن تسعير الكاشير (resolvePromotionForLine).
 * مراجعة عدائية ١٣/٧: 0073 أضاف isStoreManaged بعد أن كشفت المراجعة أن branch+tier لا يميّزان القناتين.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { extractInsertId } from "../../../lib/insertId";
import { withTx } from "../../tx";
import { resolvePromotionForLine } from "../../salesPromotionService";
import { createStorePromotion, deactivateStorePromotion, listStorePromotions } from "../storePromotionService";
import { truncateTables } from "../../__tests__/__testUtils__";

const STORE = 1; // فرع المتجر
const OTHER = 2; // فرع آخر
const TODAY = "2026-07-12";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedPromo(over: Partial<typeof s.promotions.$inferInsert> & { name: string }) {
  const res = await db().insert(s.promotions).values({
    type: "PERCENT", discountPercent: "10", discountAmount: "0", scope: "ALL",
    effectiveFrom: new Date("2026-01-01"), effectiveTo: null,
    minLineAmount: "0", priority: 0, isActive: true, isStoreManaged: false, createdBy: 1,
    ...over,
  });
  return extractInsertId(res);
}

beforeEach(async () => {
  await truncateTables(["promotionTargets", "promotions", "categories", "branches", "users"]);
  await db().insert(s.branches).values([
    { id: STORE, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: OTHER, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
});

describe("createStorePromotion — يفرض RETAIL + فرع المتجر + isStoreManaged", () => {
  it("العرض المُنشأ من المتجر = RETAIL + فرع المتجر + isStoreManaged (أونلاين، يظهر في المتجر)", async () => {
    const id = await withTx((tx) => createStorePromotion(tx, {
      name: "عودة المدارس", type: "PERCENT", discountPercent: "15", scope: "ALL", effectiveFrom: "2026-07-01",
    }, 1, STORE));
    const p = (await db().select().from(s.promotions).where(eq(s.promotions.id, id)))[0];
    expect(p.customerTier).toBe("RETAIL");
    expect(Number(p.branchId)).toBe(STORE);
    expect(p.isStoreManaged).toBe(true);
  });
});

describe("listStorePromotions — تصفية + ملكية القناة", () => {
  it("يشمل عروض المتجر والعامّة على الفرع، ويستبعد فرعاً آخر وفئة الجملة", async () => {
    const owned = await seedPromo({ name: "متجريّ", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true });
    const global = await seedPromo({ name: "عامّ", branchId: null, customerTier: null });
    await seedPromo({ name: "فرع آخر", branchId: OTHER, customerTier: "RETAIL" });
    await seedPromo({ name: "جملة", branchId: STORE, customerTier: "WHOLESALE" });

    const rows = await listStorePromotions({ branchId: STORE, todayYmd: TODAY });
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([owned, global].sort((a, b) => a - b));
    expect(rows.find((r) => r.id === owned)!.storeOwned).toBe(true);
    expect(rows.find((r) => r.id === global)!.storeOwned).toBe(false);
  });

  it("عرض كاشير RETAIL@فرع-المتجر (غير store-managed) يظهر للسياق لكن storeOwned=false", async () => {
    // نفس branch+tier لعرض المتجر تماماً — التمييز الوحيد هو isStoreManaged (لبّ مراجعة ١٣/٧).
    const posRetail = await seedPromo({ name: "خصم كاشير مفرد", branchId: STORE, customerTier: "RETAIL", isStoreManaged: false });
    const rows = await listStorePromotions({ branchId: STORE, todayYmd: TODAY });
    expect(rows.find((r) => r.id === posRetail)!.storeOwned).toBe(false);
  });

  it("liveNow: نشِطٌ ضمن نافذة اليوم=true، منتهٍ=false، مستقبليّ=false", async () => {
    const live = await seedPromo({ name: "ساري", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true, effectiveFrom: new Date("2026-07-01"), effectiveTo: new Date("2026-07-31") });
    const expired = await seedPromo({ name: "منتهٍ", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true, effectiveFrom: new Date("2026-06-01"), effectiveTo: new Date("2026-06-30") });
    const future = await seedPromo({ name: "قادم", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true, effectiveFrom: new Date("2026-08-01"), effectiveTo: null });

    const rows = await listStorePromotions({ branchId: STORE, todayYmd: TODAY });
    expect(rows.find((r) => r.id === live)!.liveNow).toBe(true);
    expect(rows.find((r) => r.id === expired)!.liveNow).toBe(false);
    expect(rows.find((r) => r.id === future)!.liveNow).toBe(false);
  });

  it("المعطَّلة تُستبعَد افتراضياً وتظهر مع includeInactive", async () => {
    await seedPromo({ name: "معطَّل", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true, isActive: false });
    expect(await listStorePromotions({ branchId: STORE, todayYmd: TODAY })).toHaveLength(0);
    const all = await listStorePromotions({ branchId: STORE, todayYmd: TODAY, includeInactive: true });
    expect(all).toHaveLength(1);
    expect(all[0].liveNow).toBe(false);
  });

  it("targetCount يعكس عدد الأهداف", async () => {
    await db().insert(s.categories).values([{ id: 1, name: "قرطاسية" }, { id: 2, name: "هدايا" }]);
    const id = await seedPromo({ name: "فئات", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true, scope: "CATEGORIES" });
    await db().insert(s.promotionTargets).values([{ promotionId: id, categoryId: 1 }, { promotionId: id, categoryId: 2 }]);
    const rows = await listStorePromotions({ branchId: STORE, todayYmd: TODAY });
    expect(rows.find((r) => r.id === id)!.targetCount).toBe(2);
  });
});

describe("deactivateStorePromotion — الملكية بعلامة القناة (منع IDOR)", () => {
  it("يُعطّل عرض المتجر (isStoreManaged)", async () => {
    const id = await seedPromo({ name: "متجريّ", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true });
    await withTx((tx) => deactivateStorePromotion(tx, id));
    const p = (await db().select().from(s.promotions).where(eq(s.promotions.id, id)))[0];
    expect(p.isActive).toBe(false);
  });

  it("يرفض تعطيل عرض كاشير RETAIL@فرع-المتجر (نفس branch+till، غير store-managed) ⇒ FORBIDDEN", async () => {
    const id = await seedPromo({ name: "خصم كاشير مفرد", branchId: STORE, customerTier: "RETAIL", isStoreManaged: false });
    await expect(withTx((tx) => deactivateStorePromotion(tx, id))).rejects.toThrow(/ليس من عروض المتجر/);
    const p = (await db().select().from(s.promotions).where(eq(s.promotions.id, id)))[0];
    expect(p.isActive).toBe(true);
  });

  it("يرفض تعطيل عرض عامّ (NULL/NULL) ⇒ FORBIDDEN", async () => {
    const id = await seedPromo({ name: "عامّ", branchId: null, customerTier: null });
    await expect(withTx((tx) => deactivateStorePromotion(tx, id))).rejects.toThrow(/ليس من عروض المتجر/);
  });

  it("عرض غير موجود ⇒ NOT_FOUND", async () => {
    await expect(withTx((tx) => deactivateStorePromotion(tx, 999999))).rejects.toThrow(/غير موجود/);
  });
});

describe("عزل القناة — عرض المتجر أونلاين فقط (لا يخصم بيع الكاشير)", () => {
  async function resolve(promoId: number, includeStoreManaged: boolean) {
    return withTx((tx) => resolvePromotionForLine(tx, {
      branchId: STORE, customerTier: "RETAIL", productId: 1, variantId: 1, categoryId: null,
      unitPrice: "1000.00", lineAmount: "1000.00", hasContractPrice: false, todayYmd: TODAY, includeStoreManaged,
    }));
  }

  it("عرض متجر (isStoreManaged) يُستثنى من تسعير الكاشير (includeStoreManaged=false) ويُدرَج للمتجر (true)", async () => {
    await seedPromo({ name: "عرض متجر ٢٠٪", branchId: STORE, customerTier: "RETAIL", isStoreManaged: true, discountPercent: "20", scope: "ALL", effectiveFrom: new Date("2026-07-01") });
    expect(await resolve(1, false)).toBeNull(); // الكاشير: لا خصم
    const online = await resolve(1, true); // المتجر: يُطبَّق
    expect(online).not.toBeNull();
    expect(online!.discountForUnit).toBe("200.00"); // ٢٠٪ من ١٠٠٠
  });

  it("عرض كاشير عامّ (غير store-managed) يُطبَّق على الكاشير في الحالتين", async () => {
    await seedPromo({ name: "خصم كاشير", branchId: STORE, customerTier: "RETAIL", isStoreManaged: false, discountPercent: "10", scope: "ALL", effectiveFrom: new Date("2026-07-01") });
    const pos = await resolve(1, false);
    expect(pos).not.toBeNull();
    expect(pos!.discountForUnit).toBe("100.00"); // ١٠٪ من ١٠٠٠ — الكاشير يطبّقه
  });
});
