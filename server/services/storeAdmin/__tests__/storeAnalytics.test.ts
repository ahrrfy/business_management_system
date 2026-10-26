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
  /** أجرة شحن (تمرير كامل): total = subtotal + shipping؛ الإيراد يجب أن يعتمد subtotal لا total. */
  shipping?: string;
  invoiceId?: number | null;
}) {
  orderSeq++;
  const shipping = o.shipping ?? "0";
  const subtotal = (Number(o.total) - Number(shipping)).toFixed(2);
  const res = await db().insert(s.onlineOrders).values({
    orderNumber: `ORD-${String(orderSeq).padStart(4, "0")}`,
    customerId: 1, branchId: o.branchId,
    invoiceId: o.invoiceId ?? null,
    subtotal, shippingCost: shipping, taxAmount: "0", total: o.total,
    status: o.status, orderDate: new Date(o.date), governorate: o.gov ?? null,
  });
  return extractInsertId(res);
}
async function seedInvoice(inv: {
  branchId?: number;
  total: string;
  returnedTotal?: string;
  deliveryFee?: string;
  status?: s.Invoice["status"];
}) {
  orderSeq++;
  const deliveryFee = inv.deliveryFee ?? "0.00";
  const subtotal = (Number(inv.total) - Number(deliveryFee)).toFixed(2);
  const res = await db().insert(s.invoices).values({
    invoiceNumber: `INV-${String(orderSeq).padStart(4, "0")}`,
    sourceType: "ONLINE",
    branchId: inv.branchId ?? STORE,
    customerId: 1,
    subtotal,
    total: inv.total,
    deliveryFee,
    returnedTotal: inv.returnedTotal ?? "0.00",
    paidAmount: inv.total,
    status: inv.status ?? "PAID",
    createdBy: 1,
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
  await truncateTables(["onlineOrderItems", "onlineOrders", "invoiceItems", "invoices", "storeConversionDailyMetrics", "productVariants", "products", "customers", "branches", "users"]);
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

  it("التمرير الكامل (١٠/٨): الإيراد = البضاعة (subtotal) لا إجمالي الطلب — الشحن للمندوب مُستبعَد", async () => {
    // طلبان بشحن ٥٬٠٠٠ لكلٍّ: إجمالي الطلب (بضاعة+شحن) = ما يدفعه الزبون للمندوب؛ إيراد المكتبة
    // = البضاعة وحدها. لولا الإصلاح لجُمع total فتضخّم الإيراد بمقدار الشحن (مالُ تمرير).
    const d = await seedOrder({ branchId: STORE, status: "DELIVERED", total: "15000", shipping: "5000", date: "2026-07-03T10:00:00Z", gov: "بغداد" });
    await seedOrder({ branchId: STORE, status: "CONFIRMED", total: "25000", shipping: "5000", date: "2026-07-03T11:00:00Z", gov: "بغداد" });
    await seedItem(d, 1, 1, "10000");
    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    // البضاعة: 10,000 (مُسلَّم) + 20,000 (مؤكَّد) = 30,000 — لا 40,000 (الذي يشمل شحن 10,000).
    expect(a.kpis.revenue).toBe("30000.00");
    expect(a.kpis.deliveredRevenue).toBe("10000.00"); // بضاعة المُسلَّم وحدها لا 15,000
    expect(a.kpis.aov).toBe("15000.00"); // 30,000 / 2
    const day = a.trend.find((t) => t.ymd === "2026-07-03")!;
    expect(day.revenue).toBe("30000.00"); // الاتّجاه أيضاً بالبضاعة
    const byGov = Object.fromEntries(a.byGovernorate.map((g) => [g.governorate, g]));
    expect(byGov["بغداد"].revenue).toBe("30000.00"); // التوزيع الجغرافيّ أيضاً
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

describe("getStoreAnalytics — صافي البضاعة بعد المرتجعات والشحن وتصحيح الفواتير (Wave 4)", () => {
  it("يخصم المرتجعات الجزئية/الكاملة وأجور التوصيل ويعتمد الفاتورة المصحّحة في المؤشّرات والاتّجاه والمحافظات", async () => {
    // 1) طلب مُسلَّم: بضاعة 20,000 + أجرة توصيل على الفاتورة 3,000 (total=23,000) + مرتجع جزئي 6,000 ⇒ صافي = 14,000
    const invPartial = await seedInvoice({
      total: "23000.00",
      deliveryFee: "3000.00",
      returnedTotal: "6000.00",
      status: "PAID",
    });
    await seedOrder({
      branchId: STORE,
      status: "DELIVERED",
      total: "25000",
      shipping: "5000",
      invoiceId: invPartial,
      date: "2026-07-04T10:00:00Z",
      gov: "بغداد",
    });

    // 2) طلب مُسلَّم صُحِّحت فاتورته عبر sale/correct من 10,000 (SUPERSEDED) إلى 8,000 (PAID) ⇒ صافي = 8,000
    await seedInvoice({ total: "10000.00", status: "SUPERSEDED" });
    const invCorrected = await seedInvoice({ total: "8000.00", status: "PAID" });
    await seedOrder({
      branchId: STORE,
      status: "DELIVERED",
      total: "15000",
      shipping: "5000",
      invoiceId: invCorrected,
      date: "2026-07-04T12:00:00Z",
      gov: "بغداد",
    });

    // 3) طلب مرتبط بفاتورة بحالة RETURNED بالكامل ⇒ صافي = 0.00
    const invReturned = await seedInvoice({
      total: "12000.00",
      returnedTotal: "12000.00",
      status: "RETURNED",
    });
    await seedOrder({
      branchId: STORE,
      status: "DELIVERED",
      total: "12000",
      invoiceId: invReturned,
      date: "2026-07-04T14:00:00Z",
      gov: "البصرة",
    });

    // 4) طلب قيد التجهيز قبل الإرسال (بلا فاتورة): إجمالي 9,000 يتضمن شحن 4,000 ⇒ صافي بضاعة = 5,000
    await seedOrder({
      branchId: STORE,
      status: "CONFIRMED",
      total: "9000",
      shipping: "4000",
      date: "2026-07-04T16:00:00Z",
      gov: "البصرة",
    });

    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.kpis.revenue).toBe("27000.00"); // 14,000 + 8,000 + 0 + 5,000
    expect(a.kpis.deliveredRevenue).toBe("22000.00"); // 14,000 + 8,000 + 0
    const day = a.trend.find((t) => t.ymd === "2026-07-04")!;
    expect(day.revenue).toBe("27000.00");
    const byGov = Object.fromEntries(a.byGovernorate.map((g) => [g.governorate, g]));
    expect(byGov["بغداد"].revenue).toBe("22000.00");
    expect(byGov["البصرة"].revenue).toBe("5000.00");
  });

  it("أعلى المنتجات (topProducts) يعتمد الكمية والإيراد الصافي بعد المرتجعات الجزئية وتصحيح الفواتير بدلاً من بنود الطلب الأولية المجمّدة", async () => {
    // 1) طلب مُسلَّم: بنوده الأولية 4 أقلام × 5,000 = 20,000، أُرجع منه قلم واحد (returnedBaseQuantity=1) ⇒ الصافي 3 أقلام بـ 15,000
    const invPartial = await seedInvoice({
      total: "20000.00",
      returnedTotal: "5000.00",
      status: "PAID",
    });
    const ordPartial = await seedOrder({
      branchId: STORE,
      status: "DELIVERED",
      total: "20000",
      invoiceId: invPartial,
      date: "2026-07-04T10:00:00Z",
      gov: "بغداد",
    });
    await seedItem(ordPartial, 1, 4, "20000.00");
    await db().insert(s.invoiceItems).values({
      invoiceId: invPartial,
      variantId: 1,
      quantity: "4.000",
      baseQuantity: 4,
      returnedBaseQuantity: 1,
      unitPrice: "5000.00",
      total: "20000.00",
    });

    // 2) طلب صُحِّحت فاتورته من 3 دفاتر (12,000) إلى دفترين (8,000) عبر sale/correct
    const invCorrected = await seedInvoice({ total: "8000.00", status: "PAID" });
    const ordCorrected = await seedOrder({
      branchId: STORE,
      status: "DELIVERED",
      total: "12000",
      invoiceId: invCorrected,
      date: "2026-07-04T12:00:00Z",
      gov: "بغداد",
    });
    await seedItem(ordCorrected, 2, 3, "12000.00");
    await db().insert(s.invoiceItems).values({
      invoiceId: invCorrected,
      variantId: 2,
      quantity: "2.000",
      baseQuantity: 2,
      returnedBaseQuantity: 0,
      unitPrice: "4000.00",
      total: "8000.00",
    });

    // 3) طلب قبل الإرسال (بلا فاتورة): دفتر واحد بـ 4,000 ⇒ يُجمع من onlineOrderItems
    const ordPending = await seedOrder({
      branchId: STORE,
      status: "CONFIRMED",
      total: "4000",
      date: "2026-07-04T14:00:00Z",
      gov: "البصرة",
    });
    await seedItem(ordPending, 2, 1, "4000.00");

    const a = await getStoreAnalytics({ scopedBranchId: STORE, fromYmd: FROM, toYmd: TO });
    expect(a.kpis.revenue).toBe("27000.00"); // 15,000 + 8,000 + 4,000
    const pen = a.topProducts.find((p) => p.name === "قلم")!;
    const notebook = a.topProducts.find((p) => p.name === "دفتر")!;
    expect(pen).toEqual({ productId: 1, name: "قلم", qty: 3, revenue: "15000.00" });
    expect(notebook).toEqual({ productId: 2, name: "دفتر", qty: 3, revenue: "12000.00" });
  });
});
