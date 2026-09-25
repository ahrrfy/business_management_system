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

  it("يدعم بذر عينة استرشادية واقعية للمعرض عند الحاجة", async () => {
    const inserted = await seedShowroomSampleAnalytics(15);
    expect(inserted).toBeGreaterThanOrEqual(0);

    const stats = await getShelfBeneficiariesStats({ range: "7d" });
    expect(stats.totalScans).toBeGreaterThanOrEqual(inserted);
    expect(stats.recentScans.length).toBeGreaterThan(0);
  });
});
