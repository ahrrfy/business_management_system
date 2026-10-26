/**
 * storeAnalyticsService — «التحليلات» في لوحة hPanel: أداء المتجر الإلكترونيّ على مدى فترة.
 *
 * مصدر البيانات: onlineOrders (+ بنودها) مباشرةً — لا يمسّ التكلفة/الربح إطلاقاً (خطّ §٦ الأحمر)،
 * بل إيراد الطلبات وعددها ومتوسّطها ونِسب التسليم/الإلغاء وأعلى المنتجات والتوزيع الجغرافيّ.
 * الإيراد = Σ **subtotal** (قيمة البضاعة) للطلبات **غير الملغاة**، والمُسلَّم منفصلٌ (نقدٌ مُحقَّق).
 * ١٠/٨ (التمرير الكامل): أجرة الشحن (total − subtotal) يقبضها المندوب الخارجيّ من الزبون
 * ويحتفظ بها — ليست إيراد المكتبة، فتُستبعَد من كل مقاييس «الإيراد/النقد المحقَّق» هنا كي لا
 * يتضخّم رقمُ الأداء بمال تمرير (كان يجمع total فيتجاوز إيراد الدفتر بمقدار الشحن). subtotal
 * = البضاعة للطلب القديم والجديد معاً ⇒ الإصلاح متّسق تاريخياً.
 * النطاق الزمنيّ بحبيبة يوم بغداد (UTC+3): الحدود تُحسب كلحظات UTC فيبقى الفلتر على العمود مفهرَساً.
 * عزل الفرع: يُمرَّر scopedBranchId (null للمرتفعين ⇒ كل المتجر)، كبقيّة راوتر الطلبات.
 */
import { and, desc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import { invoiceItems, invoices, onlineOrderItems, onlineOrders, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { currentOnlineOrderStatus } from "./onlineOrderTracking";
import { money, toDbMoney } from "../money";
import { getStoreConversionFunnel, getStoreRecommendationClickSummary, type StoreConversionFunnel, type RecommendationClickSummary } from "./storeConversionMetricsService";

/** يُطبّع قيمة تاريخ (Date أو نصّ) إلى YYYY-MM-DD بمكوّنات UTC (DATE بلا زمن ⇒ لا انزلاق). */
function toYmd(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}

/** حدود UTC لنافذة [fromYmd, toYmd] بحبيبة يوم بغداد (شامل الطرفين): [from 00:00 بغداد, (to+1) 00:00 بغداد). */
function rangeUtc(fromYmd: string, toYmd: string): { fromUtc: Date; toUtc: Date } {
  const fromUtc = new Date(`${fromYmd}T00:00:00+03:00`);
  const toStart = new Date(`${toYmd}T00:00:00+03:00`);
  const toUtc = new Date(toStart.getTime() + 24 * 60 * 60 * 1000);
  return { fromUtc, toUtc };
}

/** قائمة أيّام النافذة (شامل) YYYY-MM-DD — لملء فجوات المخطّط. مسقوفة بـ٩٢ يوماً دفاعاً. */
function dayList(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  let cur = new Date(`${fromYmd}T00:00:00Z`);
  const end = new Date(`${toYmd}T00:00:00Z`);
  for (let i = 0; i < 92 && cur.getTime() <= end.getTime(); i++) {
    out.push(toYmd_(cur));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}
function toYmd_(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface StoreAnalyticsKpis {
  totalOrders: number;
  activeOrders: number; // غير الملغاة
  cancelledOrders: number;
  deliveredOrders: number;
  revenue: string; // صافي البضاعة للطلبات غير الملغاة (بعد خصم الشحن والمرتجعات)
  deliveredRevenue: string; // صافي البضاعة للمُسلَّمة (بعد خصم الشحن والمرتجعات)
  aov: string; // متوسّط قيمة الطلب = revenue / activeOrders
  fulfillmentRate: number; // delivered / activeOrders (0..1)
  cancellationRate: number; // cancelled / totalOrders (0..1)
}

export interface StoreAnalytics {
  from: string;
  to: string;
  kpis: StoreAnalyticsKpis;
  trend: { ymd: string; orders: number; revenue: string }[];
  statusBreakdown: Record<string, number>;
  topProducts: { productId: number; name: string; qty: number; revenue: string }[];
  byGovernorate: { governorate: string; orders: number; revenue: string }[];
  conversionFunnel: StoreConversionFunnel;
  recommendationClicks: RecommendationClickSummary[];
}

const EMPTY_KPIS: StoreAnalyticsKpis = {
  totalOrders: 0, activeOrders: 0, cancelledOrders: 0, deliveredOrders: 0,
  revenue: "0.00", deliveredRevenue: "0.00", aov: "0.00", fulfillmentRate: 0, cancellationRate: 0,
};

/**
 * مصدر الحقيقة الواحد لصافي قيمة البضاعة لكل طلب متجر:
 * - عند وجود فاتورة مرتبطة (`invoiceId IS NOT NULL`): يُعتمد صافي الفاتورة الفعليّ
 *   بعد طرح المرتجعات (`returnedTotal`) وأجرة التوصيل (`deliveryFee`) مع تصفير الفواتير الملغاة/المرتجعة/المستبدلة.
 * - قبل الإرسال (`invoiceId IS NULL`): يُعتمد صافي البضاعة (`total - shippingCost`).
 */
const netMerchandiseExpr = sql<string>`(
  CASE
    WHEN ${onlineOrders.invoiceId} IS NOT NULL AND ${invoices.id} IS NOT NULL THEN
      CASE
        WHEN ${invoices.status} IN ('CANCELLED', 'RETURNED', 'SUPERSEDED') THEN 0
        ELSE GREATEST(${invoices.total} - COALESCE(${invoices.returnedTotal}, 0) - COALESCE(${invoices.deliveryFee}, 0), 0)
      END
    ELSE GREATEST(${onlineOrders.total} - COALESCE(${onlineOrders.shippingCost}, 0), 0)
  END
)`;

export async function getStoreAnalytics(input: {
  scopedBranchId: number | null;
  fromYmd: string;
  toYmd: string;
}): Promise<StoreAnalytics> {
  const db = getDb();
  const from = input.fromYmd;
  const to = input.toYmd;
  if (!db) {
    return { from, to, kpis: EMPTY_KPIS, trend: [], statusBreakdown: {}, topProducts: [], byGovernorate: [], conversionFunnel: await getStoreConversionFunnel(input), recommendationClicks: await getStoreRecommendationClickSummary(input) };
  }
  const { fromUtc, toUtc } = rangeUtc(from, to);
  const base = [gte(onlineOrders.orderDate, fromUtc), lt(onlineOrders.orderDate, toUtc)];
  if (input.scopedBranchId != null) base.push(eq(onlineOrders.branchId, input.scopedBranchId));
  const where = and(...base);

  // 1) مؤشّرات مجمَّعة
  const [k] = await db
    .select({
      totalOrders: sql<number>`COUNT(*)`,
      cancelledOrders: sql<number>`COALESCE(SUM(${currentOnlineOrderStatus} = 'CANCELLED'), 0)`,
      deliveredOrders: sql<number>`COALESCE(SUM(${currentOnlineOrderStatus} = 'DELIVERED'), 0)`,
      revenue: sql<string>`COALESCE(SUM(CASE WHEN ${currentOnlineOrderStatus} <> 'CANCELLED' THEN ${netMerchandiseExpr} ELSE 0 END), 0)`,
      deliveredRevenue: sql<string>`COALESCE(SUM(CASE WHEN ${currentOnlineOrderStatus} = 'DELIVERED' THEN ${netMerchandiseExpr} ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
    .leftJoin(invoices, eq(invoices.id, onlineOrders.invoiceId))
    .where(where);

  const totalOrders = Number(k?.totalOrders ?? 0);
  const cancelledOrders = Number(k?.cancelledOrders ?? 0);
  const deliveredOrders = Number(k?.deliveredOrders ?? 0);
  const activeOrders = totalOrders - cancelledOrders;
  const revenue = toDbMoney(money(k?.revenue ?? "0"));
  const deliveredRevenue = toDbMoney(money(k?.deliveredRevenue ?? "0"));
  const aov = activeOrders > 0 ? toDbMoney(money(revenue).dividedBy(activeOrders)) : "0.00";

  // 2) توزيع الحالات
  const currentOrders = db.select({ status: currentOnlineOrderStatus.as("currentStatus") })
    .from(onlineOrders).where(where).as("currentOrders");
  const stRows = await db.select({ status: currentOrders.status, n: sql<number>`COUNT(*)` })
    .from(currentOrders).groupBy(currentOrders.status);
  const statusBreakdown: Record<string, number> = {};
  for (const r of stRows) statusBreakdown[r.status] = Number(r.n);

  // 3) اتّجاه يوميّ (بحبيبة يوم بغداد) + ملء الفجوات
  const dayExpr = sql`DATE(${onlineOrders.orderDate} + INTERVAL 3 HOUR)`;
  const trendRows = await db
    .select({
      ymd: sql<string>`DATE(${onlineOrders.orderDate} + INTERVAL 3 HOUR)`,
      orders: sql<number>`COUNT(*)`,
      revenue: sql<string>`COALESCE(SUM(CASE WHEN ${currentOnlineOrderStatus} <> 'CANCELLED' THEN ${netMerchandiseExpr} ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
    .leftJoin(invoices, eq(invoices.id, onlineOrders.invoiceId))
    .where(where)
    .groupBy(dayExpr)
    .orderBy(dayExpr);
  const trendByDay = new Map<string, { orders: number; revenue: string }>();
  for (const r of trendRows) trendByDay.set(toYmd(r.ymd), { orders: Number(r.orders), revenue: toDbMoney(money(r.revenue ?? "0")) });
  const trend = dayList(from, to).map((ymd) => ({
    ymd,
    orders: trendByDay.get(ymd)?.orders ?? 0,
    revenue: trendByDay.get(ymd)?.revenue ?? "0.00",
  }));

  // 4) أعلى المنتجات (بالإيراد الصافي) — يعتمد بنود الفاتورة الصافية بعد المرتجعات الجزئية
  // وتصحيح الفواتير (`sale/correct`) عند وجود بنود فاتورة، ويسقط لبنود الطلب الأولية قبل الإرسال فقط.
  const invoicedLineRevenueExpr = sql<string>`CASE
    WHEN ${invoiceItems.baseQuantity} > 0 THEN ROUND(
      ${invoiceItems.total}
      * (${invoiceItems.baseQuantity} - ${invoiceItems.returnedBaseQuantity})
      / ${invoiceItems.baseQuantity}
      * (CASE
          WHEN ${invoices.subtotal} > 0 AND COALESCE(${invoices.discountAmount}, 0) > 0
            THEN GREATEST(${invoices.subtotal} - COALESCE(${invoices.discountAmount}, 0), 0) / ${invoices.subtotal}
          ELSE 1
        END),
      2
    )
    ELSE 0
  END`;

  const [invoicedTopRows, pendingTopRows] = await Promise.all([
    db
      .select({
        productId: products.id,
        name: products.name,
        qty: sql<number>`COALESCE(SUM(${invoiceItems.baseQuantity} - ${invoiceItems.returnedBaseQuantity}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${invoicedLineRevenueExpr}), 0)`,
      })
      .from(onlineOrders)
      .innerJoin(invoices, eq(invoices.id, onlineOrders.invoiceId))
      .innerJoin(invoiceItems, eq(invoiceItems.invoiceId, invoices.id))
      .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(
        where,
        ne(currentOnlineOrderStatus, "CANCELLED"),
        sql`${invoices.status} NOT IN ('CANCELLED', 'RETURNED', 'SUPERSEDED')`,
        sql`${invoiceItems.baseQuantity} > ${invoiceItems.returnedBaseQuantity}`,
      ))
      .groupBy(products.id),
    db
      .select({
        productId: products.id,
        name: products.name,
        qty: sql<number>`COALESCE(SUM(${onlineOrderItems.baseQuantity}), 0)`,
        revenue: sql<string>`COALESCE(SUM(${onlineOrderItems.total}), 0)`,
      })
      .from(onlineOrderItems)
      .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
      .leftJoin(invoices, eq(invoices.id, onlineOrders.invoiceId))
      .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(and(
        where,
        ne(currentOnlineOrderStatus, "CANCELLED"),
        or(isNull(onlineOrders.invoiceId), isNull(invoices.id), sql`${invoices.status} NOT IN ('CANCELLED', 'RETURNED', 'SUPERSEDED')`),
        sql`NOT EXISTS (SELECT 1 FROM invoiceItems ii0 WHERE ii0.invoiceId = ${onlineOrders.invoiceId})`,
      ))
      .groupBy(products.id),
  ]);

  const mergedTopProducts = new Map<number, { productId: number; name: string; qty: number; revenue: ReturnType<typeof money> }>();
  for (const r of [...invoicedTopRows, ...pendingTopRows]) {
    const pid = Number(r.productId);
    const existing = mergedTopProducts.get(pid);
    if (existing) {
      existing.qty += Number(r.qty);
      existing.revenue = existing.revenue.plus(money(r.revenue ?? "0"));
    } else {
      mergedTopProducts.set(pid, {
        productId: pid,
        name: r.name,
        qty: Number(r.qty),
        revenue: money(r.revenue ?? "0"),
      });
    }
  }
  const topProducts = Array.from(mergedTopProducts.values())
    .sort((a, b) => b.revenue.comparedTo(a.revenue) || a.productId - b.productId)
    .slice(0, 8)
    .map((r) => ({
      productId: r.productId,
      name: r.name,
      qty: r.qty,
      revenue: toDbMoney(r.revenue),
    }));

  // 5) التوزيع الجغرافيّ (المحافظة)
  const govExpr = sql`COALESCE(NULLIF(${onlineOrders.governorate}, ''), 'غير محدَّد')`;
  const govRows = await db
    .select({
      governorate: sql<string>`COALESCE(NULLIF(${onlineOrders.governorate}, ''), 'غير محدَّد')`,
      orders: sql<number>`COUNT(*)`,
      revenue: sql<string>`COALESCE(SUM(CASE WHEN ${currentOnlineOrderStatus} <> 'CANCELLED' THEN ${netMerchandiseExpr} ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
    .leftJoin(invoices, eq(invoices.id, onlineOrders.invoiceId))
    .where(where)
    .groupBy(govExpr)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(15);
  const byGovernorate = govRows.map((r) => ({
    governorate: r.governorate,
    orders: Number(r.orders),
    revenue: toDbMoney(money(r.revenue ?? "0")),
  }));

  const conversionFunnel = await getStoreConversionFunnel(input);
  const recommendationClicks = await getStoreRecommendationClickSummary(input);
  return {
    from,
    to,
    kpis: {
      totalOrders, activeOrders, cancelledOrders, deliveredOrders,
      revenue, deliveredRevenue, aov,
      fulfillmentRate: activeOrders > 0 ? deliveredOrders / activeOrders : 0,
      cancellationRate: totalOrders > 0 ? cancelledOrders / totalOrders : 0,
    },
    trend,
    statusBreakdown,
    topProducts,
    byGovernorate,
    conversionFunnel,
    recommendationClicks,
  };
}
