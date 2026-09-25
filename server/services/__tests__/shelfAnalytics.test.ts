import { beforeEach, describe, expect, it } from "vitest";
import { branches, products, productUnits, productVariants } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  getBaghdadStartOfToday,
  getShelfBeneficiariesStats,
  recordShelfLookupEvent,
  seedShowroomSampleAnalytics,
} from "../shelfAnalyticsService";

describe("shelfAnalyticsService — محرك إحصائيات المستفيدين", () => {
  beforeEach(async () => {
    const db = getDb()!;

    // تهيئة الفروع للاختبار
    await db.insert(branches).values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ]).catch(() => {});

    // تهيئة منتج تجريبي
    const [p] = await db.insert(products).values({
      name: "دفتر تجريبي",
    }).$returningId().catch(() => [{ id: 1 }]);
    const [v] = await db.insert(productVariants).values({
      productId: p.id,
      sku: `SKU-TEST-${Date.now()}`,
      costPrice: "1000",
    }).$returningId().catch(() => [{ id: 1 }]);
    await db.insert(productUnits).values({
      variantId: v.id,
      unitName: "قطعة",
      conversionFactor: "1",
      barcode: `TEST_BARCODE_${Date.now()}`,
      isBaseUnit: true,
    }).catch(() => {});
  });

  it("يحسب بداية اليوم بتوقيت بغداد بدقة متوافقة مع UTC", () => {
    const todayStart = getBaghdadStartOfToday();
    expect(todayStart).toBeInstanceOf(Date);
    expect(Number.isNaN(todayStart.getTime())).toBe(false);
    // منتصف ليل بغداد (UTC+3) يعادل 21:00 UTC لليوم السابق
    expect(todayStart.getUTCHours()).toBe(21);
  });

  it("يسجل عمليات الاستعلام ويحسب أعداد المستفيدين والنسب الإحصائية", async () => {
    const testVisitorA = `test_vis_a_${Date.now()}`;
    const testVisitorB = `test_vis_b_${Date.now()}`;

    // تسجيل استعلامين للزائر A
    await recordShelfLookupEvent({
      visitorId: testVisitorA,
      barcode: "TEST_BARCODE_1",
      branchId: 1,
      productName: "دفتر تجريبي",
      found: true,
      deviceType: "android",
      ip: "127.0.0.1",
    });

    await recordShelfLookupEvent({
      visitorId: testVisitorA,
      barcode: "TEST_BARCODE_2",
      branchId: 1,
      productName: "قلم تجريبي",
      found: true,
      deviceType: "android",
      ip: "127.0.0.1",
    });

    // تسجيل استعلام للزائر B (صنف غير موجود)
    await recordShelfLookupEvent({
      visitorId: testVisitorB,
      barcode: "TEST_BARCODE_NOT_FOUND",
      branchId: 2,
      found: false,
      deviceType: "ios",
      ip: "127.0.0.2",
    });

    const stats = await getShelfBeneficiariesStats({ range: "all" });

    expect(stats.totalScans).toBeGreaterThanOrEqual(3);
    expect(stats.uniqueBeneficiaries).toBeGreaterThanOrEqual(2);
    expect(stats.foundScans).toBeGreaterThanOrEqual(2);
    expect(stats.notFoundScans).toBeGreaterThanOrEqual(1);
    expect(stats.successRate).toBeGreaterThan(0);
    expect(stats.deviceBreakdown.android).toBeGreaterThanOrEqual(2);
    expect(stats.deviceBreakdown.ios).toBeGreaterThanOrEqual(1);
  });

  it("يتعامل بمرونة مع معرف فرع غير موجود عبر الـ FK fallback دون إسقاط الاستعلام", async () => {
    const visitorWithInvalidBranch = `test_fk_fallback_${Date.now()}`;
    await recordShelfLookupEvent({
      visitorId: visitorWithInvalidBranch,
      barcode: "TEST_BARCODE_FALLBACK",
      branchId: 999999, // فرع غير موجود إطلاقاً
      productName: "منتج تجريبي",
      found: true,
      deviceType: "android",
    });

    const stats = await getShelfBeneficiariesStats({ range: "all" });
    const fallbackScan = stats.recentScans.find((s) => s.barcode === "TEST_BARCODE_FALLBACK");
    expect(fallbackScan).toBeDefined();
    expect(fallbackScan?.branchId).toBeNull();
  });

  it("يدعم تصفية الإحصائيات حسب الفرع بدقة ذرية", async () => {
    const branchStats = await getShelfBeneficiariesStats({ branchId: 1, range: "all" });
    expect(branchStats).toBeDefined();
    // كل العمليات في سجل recentScans يجب أن تعود للفرع 1
    for (const scan of branchStats.recentScans) {
      expect(scan.branchId).toBe(1);
    }
  });

  it("يدعم تصفية الفترات الزمنية المختلفة (today, 7d, 30d, all)", async () => {
    const todayStats = await getShelfBeneficiariesStats({ range: "today" });
    expect(todayStats).toBeDefined();
    expect(Array.isArray(todayStats.activityTimeline)).toBe(true);

    const sevenDaysStats = await getShelfBeneficiariesStats({ range: "7d" });
    expect(sevenDaysStats).toBeDefined();

    const thirtyDaysStats = await getShelfBeneficiariesStats({ range: "30d" });
    expect(thirtyDaysStats).toBeDefined();
  });

  it("يدعم بذر عينة استرشادية واقعية للمعرض عند الحاجة", async () => {
    const inserted = await seedShowroomSampleAnalytics(15);
    expect(inserted).toBeGreaterThanOrEqual(0);

    const stats = await getShelfBeneficiariesStats({ range: "7d" });
    expect(stats.totalScans).toBeGreaterThanOrEqual(inserted);
    expect(stats.recentScans.length).toBeGreaterThan(0);
  });
});
