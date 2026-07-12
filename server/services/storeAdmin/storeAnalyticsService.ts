/**
 * storeAnalyticsService — «التحليلات» في لوحة hPanel: أداء المتجر الإلكترونيّ على مدى فترة.
 *
 * مصدر البيانات: onlineOrders (+ بنودها) مباشرةً — لا يمسّ التكلفة/الربح إطلاقاً (خطّ §٦ الأحمر)،
 * بل إيراد الطلبات وعددها ومتوسّطها ونِسب التسليم/الإلغاء وأعلى المنتجات والتوزيع الجغرافيّ.
 * الإيراد = Σ total للطلبات **غير الملغاة** (قيمة مؤكَّدة/قيد التنفيذ)، والمُسلَّم منفصلٌ (نقدٌ مُحقَّق).
 * النطاق الزمنيّ بحبيبة يوم بغداد (UTC+3): الحدود تُحسب كلحظات UTC فيبقى الفلتر على العمود مفهرَساً.
 * عزل الفرع: يُمرَّر scopedBranchId (null للمرتفعين ⇒ كل المتجر)، كبقيّة راوتر الطلبات.
 */
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { onlineOrderItems, onlineOrders, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";

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
  revenue: string; // Σ total للطلبات غير الملغاة
  deliveredRevenue: string; // Σ total للمُسلَّمة
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
}

const EMPTY_KPIS: StoreAnalyticsKpis = {
  totalOrders: 0, activeOrders: 0, cancelledOrders: 0, deliveredOrders: 0,
  revenue: "0.00", deliveredRevenue: "0.00", aov: "0.00", fulfillmentRate: 0, cancellationRate: 0,
};

export async function getStoreAnalytics(input: {
  scopedBranchId: number | null;
  fromYmd: string;
  toYmd: string;
}): Promise<StoreAnalytics> {
  const db = getDb();
  const from = input.fromYmd;
  const to = input.toYmd;
  if (!db) {
    return { from, to, kpis: EMPTY_KPIS, trend: [], statusBreakdown: {}, topProducts: [], byGovernorate: [] };
  }
  const { fromUtc, toUtc } = rangeUtc(from, to);
  const base = [gte(onlineOrders.orderDate, fromUtc), lt(onlineOrders.orderDate, toUtc)];
  if (input.scopedBranchId != null) base.push(eq(onlineOrders.branchId, input.scopedBranchId));
  const where = and(...base);

  // 1) مؤشّرات مجمَّعة
  const [k] = await db
    .select({
      totalOrders: sql<number>`COUNT(*)`,
      cancelledOrders: sql<number>`COALESCE(SUM(${onlineOrders.status} = 'CANCELLED'), 0)`,
      deliveredOrders: sql<number>`COALESCE(SUM(${onlineOrders.status} = 'DELIVERED'), 0)`,
      revenue: sql<string>`COALESCE(SUM(CASE WHEN ${onlineOrders.status} <> 'CANCELLED' THEN ${onlineOrders.total} ELSE 0 END), 0)`,
      deliveredRevenue: sql<string>`COALESCE(SUM(CASE WHEN ${onlineOrders.status} = 'DELIVERED' THEN ${onlineOrders.total} ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
    .where(where);

  const totalOrders = Number(k?.totalOrders ?? 0);
  const cancelledOrders = Number(k?.cancelledOrders ?? 0);
  const deliveredOrders = Number(k?.deliveredOrders ?? 0);
  const activeOrders = totalOrders - cancelledOrders;
  const revenue = toDbMoney(money(k?.revenue ?? "0"));
  const deliveredRevenue = toDbMoney(money(k?.deliveredRevenue ?? "0"));
  const aov = activeOrders > 0 ? toDbMoney(money(revenue).dividedBy(activeOrders)) : "0.00";

  // 2) توزيع الحالات
  const stRows = await db
    .select({ status: onlineOrders.status, n: sql<number>`COUNT(*)` })
    .from(onlineOrders)
    .where(where)
    .groupBy(onlineOrders.status);
  const statusBreakdown: Record<string, number> = {};
  for (const r of stRows) statusBreakdown[r.status] = Number(r.n);

  // 3) اتّجاه يوميّ (بحبيبة يوم بغداد) + ملء الفجوات
  const dayExpr = sql`DATE(${onlineOrders.orderDate} + INTERVAL 3 HOUR)`;
  const trendRows = await db
    .select({
      ymd: sql<string>`DATE(${onlineOrders.orderDate} + INTERVAL 3 HOUR)`,
      orders: sql<number>`COUNT(*)`,
      revenue: sql<string>`COALESCE(SUM(CASE WHEN ${onlineOrders.status} <> 'CANCELLED' THEN ${onlineOrders.total} ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
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

  // 4) أعلى المنتجات (بالإيراد) — الطلبات غير الملغاة فقط
  const topRows = await db
    .select({
      productId: products.id,
      name: products.name,
      qty: sql<number>`COALESCE(SUM(${onlineOrderItems.baseQuantity}), 0)`,
      revenue: sql<string>`COALESCE(SUM(${onlineOrderItems.total}), 0)`,
    })
    .from(onlineOrderItems)
    .innerJoin(onlineOrders, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(where, ne(onlineOrders.status, "CANCELLED")))
    .groupBy(products.id)
    .orderBy(desc(sql`SUM(${onlineOrderItems.total})`))
    .limit(8);
  const topProducts = topRows.map((r) => ({
    productId: Number(r.productId),
    name: r.name,
    qty: Number(r.qty),
    revenue: toDbMoney(money(r.revenue ?? "0")),
  }));

  // 5) التوزيع الجغرافيّ (المحافظة)
  const govExpr = sql`COALESCE(NULLIF(${onlineOrders.governorate}, ''), 'غير محدَّد')`;
  const govRows = await db
    .select({
      governorate: sql<string>`COALESCE(NULLIF(${onlineOrders.governorate}, ''), 'غير محدَّد')`,
      orders: sql<number>`COUNT(*)`,
      revenue: sql<string>`COALESCE(SUM(CASE WHEN ${onlineOrders.status} <> 'CANCELLED' THEN ${onlineOrders.total} ELSE 0 END), 0)`,
    })
    .from(onlineOrders)
    .where(where)
    .groupBy(govExpr)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(15);
  const byGovernorate = govRows.map((r) => ({
    governorate: r.governorate,
    orders: Number(r.orders),
    revenue: toDbMoney(money(r.revenue ?? "0")),
  }));

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
  };
}
