/**
 * اختبارات storeAnalyticsService — «التحليلات» في لوحة hPanel.
 * يغطّي: مؤشّرات الإيراد/العدد/المتوسّط/التسليم/الإلغاء (استبعاد الملغاة من الإيراد)، توزيع الحالات،
 * الاتّجاه اليوميّ (بحبيبة بغداد + ملء الفجوات)، أعلى المنتجات (بلا ملغاة)، التوزيع الجغرافيّ،
 * وفلترة النطاق الزمنيّ + عزل الفرع.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { extractInsertId } from "../../../lib/insertId";
import { getStoreAnalytics } from "../storeAnalyticsService";
import { truncateTables } from "../../__tests__/__testUtils__";

const STORE = 1;
const OTHER = 2;
const FROM = "2026-07-01";
const TO = "2026-07-10";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

let orderSeq = 0;
async function seedOrder(o: {
  branchId: number; status: s.OnlineOrder["status"]; total: string; date: string; gov?: string | null;
}) {
  orderSeq++;
  const res = await db().insert(s.onlineOrders).values({
    orderNumber: `ORD-${String(orderSeq).padStart(4, "0")}`,
    customerId: 1, branchId: o.branchId,
    subtotal: o.total, shippingCost: "0", taxAmount: "0", total: o.total,
    status: o.status, orderDate: new Date(o.date), governorate: o.gov ?? null,
  });
  return extractInsertId(res);
}
async function seedItem(orderId: number, variantId: number, baseQty: number, total: string) {
  await db().insert(s.onlineOrderItems).values({
    onlineOrderId: orderId, variantId, quantity: String(baseQty), baseQuantity: baseQty, unitPrice: total, total,
  });
}

beforeEach(async () => {
  orderSeq = 0;
  await truncateTables(["onlineOrderItems", "onlineOrders", "storeConversionDailyMetrics", "productVariants", "products", "customers", "branches", "users"]);
  await db().insert(s.branches).values([
    { id: STORE, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: OTHER, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await db().insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await db().insert(s.customers).values({ id: 1, name: "زبون" });
  await db().insert(s.products).values([{ id: 1, name: "قلم" }, { id: 2, name: "دفتر" }]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "V1", costPrice: "0" },
    { id: 2, productId: 2, sku: "V2", costPrice: "0" },
  ]);
});

describe("getStoreAnalytics conversion funnel", () => {
  it("aggregates only the requested branch and date window", async () => {
    await db().insert(s.storeConversionDailyMetrics).values([
      { branchId: STORE, metricDate: "2026-07-02", productViews: 100, cartAdds: 25, checkoutStarts: 12, completedOrders: 9 },
      { branchId: STORE, metricDate: "2026-07-05", productViews: 50, cartAdds: 10, checkoutStarts: 4, completedOrders: 3 },
      { branchId: OTHER, metricDate: "2026-07-02", productViews: 999, cartAdds: 999, checkoutStarts: 999, completedOrders: 999 },
      { branchId: STORE, metricDate: "2026-06-20", productViews: 999, cartAdds: 999, checkoutStarts: 999, completedOrders: 999 },
    ]);
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.conversionFunnel).toMatchObject({ productViews: 150, cartAdds: 35, checkoutStarts: 16, completedOrders: 12 });
    expect(a.conversionFunnel.viewToCartRate).toBeCloseTo(35 / 150);
    expect(a.conversionFunnel.cartToCheckoutRate).toBeCloseTo(16 / 35);
    expect(a.conversionFunnel.checkoutToOrderRate).toBeCloseTo(12 / 16);
  });
});

/** سيناريو أساسيّ على فرع المتجر داخل النافذة + طلب فرعٍ آخر + طلب خارج النطاق. */
async function seedScenario() {
  const o1 = await seedOrder({ branchId: STORE, status: "DELIVERED", total: "10000", date: "2026-07-02T10:00:00Z", gov: "بغداد" });
  const o2 = await seedOrder({ branchId: STORE, status: "CONFIRMED", total: "5000", date: "2026-07-02T12:00:00Z", gov: "بغداد" });
  const o3 = await seedOrder({ branchId: STORE, status: "PENDING", total: "3000", date: "2026-07-05T09:00:00Z", gov: "البصرة" });
  const o4 = await seedOrder({ branchId: STORE, status: "CANCELLED", total: "8000", date: "2026-07-05T11:00:00Z", gov: "البصرة" });
  const o5 = await seedOrder({ branchId: STORE, status: "DELIVERED", total: "7000", date: "2026-07-08T14:00:00Z", gov: null });
  await seedOrder({ branchId: OTHER, status: "DELIVERED", total: "99999", date: "2026-07-03T10:00:00Z", gov: "أربيل" });
  await seedOrder({ branchId: STORE, status: "DELIVERED", total: "50000", date: "2026-06-20T10:00:00Z", gov: "بغداد" }); // خارج النطاق
  // بنود (أعلى المنتجات): الملغى o4 يجب أن يُستبعَد
  await seedItem(o1, 1, 5, "10000");
  await seedItem(o2, 2, 2, "5000");
  await seedItem(o3, 1, 1, "3000");
  await seedItem(o4, 1, 10, "8000");
  await seedItem(o5, 2, 3, "7000");
  return { o1, o2, o3, o4, o5 };
}

describe("getStoreAnalytics — المؤشّرات", () => {
  it("يحسب العدد/الإيراد/المتوسّط/النِّسب مع استبعاد الملغاة من الإيراد وعزل الفرع", async () => {
    await seedScenario();
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.kpis.totalOrders).toBe(5); // o1..o5 (لا فرع آخر، لا خارج النطاق)
    expect(a.kpis.cancelledOrders).toBe(1);
    expect(a.kpis.deliveredOrders).toBe(2);
    expect(a.kpis.activeOrders).toBe(4);
    expect(a.kpis.revenue).toBe("25000.00"); // 10000+5000+3000+7000 (o4 مستبعَد)
    expect(a.kpis.deliveredRevenue).toBe("17000.00"); // 10000+7000
    expect(a.kpis.aov).toBe("6250.00"); // 25000/4
    expect(a.kpis.fulfillmentRate).toBeCloseTo(0.5); // 2/4
    expect(a.kpis.cancellationRate).toBeCloseTo(0.2); // 1/5
  });

  it("scopedBranchId=null يشمل كل الفروع", async () => {
    await seedScenario();
    const a = await getStoreAnalytics({ scopedBranchId: null, fromYmd: FROM, toYmd: TO });
    expect(a.kpis.totalOrders).toBe(6); // + طلب الفرع الآخر
    expect(a.kpis.revenue).toBe("124999.00"); // 25000 + 99999
  });
});

describe("getStoreAnalytics — التوزيعات", () => {
  it("توزيع الحالات صحيح", async () => {
    await seedScenario();
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.statusBreakdown).toMatchObject({ DELIVERED: 2, CONFIRMED: 1, PENDING: 1, CANCELLED: 1 });
  });

  it("الاتّجاه اليوميّ يملأ الفجوات (١٠ أيّام) ويستبعد الملغى من الإيراد", async () => {
    await seedScenario();
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.trend).toHaveLength(10); // 07-01..07-10
    const d2 = a.trend.find((t) => t.ymd === "2026-07-02")!;
    expect(d2).toMatchObject({ orders: 2, revenue: "15000.00" });
    const d5 = a.trend.find((t) => t.ymd === "2026-07-05")!;
    expect(d5).toMatchObject({ orders: 2, revenue: "3000.00" }); // o3+o4 عدداً، o4 خارج الإيراد
    const d1 = a.trend.find((t) => t.ymd === "2026-07-01")!;
    expect(d1).toMatchObject({ orders: 0, revenue: "0.00" });
  });

  it("أعلى المنتجات بالإيراد، والملغى مستبعَد", async () => {
    await seedScenario();
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.topProducts.map((p) => p.name)).toEqual(["قلم", "دفتر"]);
    const pen = a.topProducts.find((p) => p.name === "قلم")!;
    expect(pen.revenue).toBe("13000.00"); // 10000(o1)+3000(o3) — 8000(o4 ملغى) مستبعَد
    expect(pen.qty).toBe(6); // 5+1
  });

  it("التوزيع الجغرافيّ يجمع بالمحافظة و null⇒«غير محدَّد»", async () => {
    await seedScenario();
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    const byGov = Object.fromEntries(a.byGovernorate.map((g) => [g.governorate, g]));
    expect(byGov["بغداد"]).toMatchObject({ orders: 2, revenue: "15000.00" });
    expect(byGov["البصرة"]).toMatchObject({ orders: 2, revenue: "3000.00" }); // o4 ملغى خارج الإيراد
    expect(byGov["غير محدَّد"]).toMatchObject({ orders: 1, revenue: "7000.00" });
  });
});

describe("getStoreAnalytics — حالات حدّية", () => {
  it("نافذة بلا طلبات ⇒ مؤشّرات صفريّة + اتّجاه مملوء", async () => {
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.kpis.totalOrders).toBe(0);
    expect(a.kpis.revenue).toBe("0.00");
    expect(a.kpis.aov).toBe("0.00");
    expect(a.kpis.fulfillmentRate).toBe(0);
    expect(a.kpis.cancellationRate).toBe(0);
    expect(a.trend).toHaveLength(10);
    expect(a.topProducts).toHaveLength(0);
  });
});
