import { and, eq, gte, lte, sql } from "drizzle-orm";
import { storeConversionDailyMetrics } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { resolveStorefrontBranchId } from "../storefrontService";

export type StoreConversionEvent = "PRODUCT_VIEW" | "ADD_TO_CART" | "BEGIN_CHECKOUT" | "ORDER_COMPLETED";

function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * يسجل عداداً يومياً مجمّعاً فقط. لا يكتب IP أو معرف جلسة أو product/customer IDs؛
 * فالأرقام هنا صالحة لقياس القمع وليست لتتبّع الأشخاص.
 * فشل القياس لا يجوز أن يعطّل شراء العميل.
 */
export async function recordStoreConversionMetric(input: {
  event: StoreConversionEvent;
  branchId?: number;
}): Promise<{ ok: true }> {
  try {
    const db = getDb();
    if (!db) return { ok: true };
    const branchId = await resolveStorefrontBranchId(input.branchId);
    const metricDate = todayYmdBaghdad();
    const productViews = input.event === "PRODUCT_VIEW" ? 1 : 0;
    const cartAdds = input.event === "ADD_TO_CART" ? 1 : 0;
    const checkoutStarts = input.event === "BEGIN_CHECKOUT" ? 1 : 0;
    const completedOrders = input.event === "ORDER_COMPLETED" ? 1 : 0;
    await db.execute(sql`
      INSERT INTO storeConversionDailyMetrics
        (branchId, metricDate, productViews, cartAdds, checkoutStarts, completedOrders)
      VALUES (${branchId}, ${metricDate}, ${productViews}, ${cartAdds}, ${checkoutStarts}, ${completedOrders})
      ON DUPLICATE KEY UPDATE
        productViews = productViews + ${productViews},
        cartAdds = cartAdds + ${cartAdds},
        checkoutStarts = checkoutStarts + ${checkoutStarts},
        completedOrders = completedOrders + ${completedOrders}
    `);
  } catch {
    // القياس أفضل-جهد فقط؛ لا يكسر عملية الطلب عند خلل قاعدة البيانات/التحليلات.
  }
  return { ok: true };
}

export interface StoreConversionFunnel {
  productViews: number;
  cartAdds: number;
  checkoutStarts: number;
  completedOrders: number;
  viewToCartRate: number;
  cartToCheckoutRate: number;
  checkoutToOrderRate: number;
}

const EMPTY_FUNNEL: StoreConversionFunnel = {
  productViews: 0, cartAdds: 0, checkoutStarts: 0, completedOrders: 0,
  viewToCartRate: 0, cartToCheckoutRate: 0, checkoutToOrderRate: 0,
};

/** قراءة القمع المجمع ضمن نافذة التحليلات، مع احترام عزل الفرع الإداري. */
export async function getStoreConversionFunnel(input: {
  scopedBranchId: number | null;
  fromYmd: string;
  toYmd: string;
}): Promise<StoreConversionFunnel> {
  const db = getDb();
  if (!db) return EMPTY_FUNNEL;
  const conditions = [
    gte(storeConversionDailyMetrics.metricDate, input.fromYmd),
    lte(storeConversionDailyMetrics.metricDate, input.toYmd),
  ];
  if (input.scopedBranchId != null) conditions.push(eq(storeConversionDailyMetrics.branchId, input.scopedBranchId));
  const [row] = await db
    .select({
      productViews: sql<number>`COALESCE(SUM(${storeConversionDailyMetrics.productViews}), 0)`,
      cartAdds: sql<number>`COALESCE(SUM(${storeConversionDailyMetrics.cartAdds}), 0)`,
      checkoutStarts: sql<number>`COALESCE(SUM(${storeConversionDailyMetrics.checkoutStarts}), 0)`,
      completedOrders: sql<number>`COALESCE(SUM(${storeConversionDailyMetrics.completedOrders}), 0)`,
    })
    .from(storeConversionDailyMetrics)
    .where(and(...conditions));
  const productViews = Number(row?.productViews ?? 0);
  const cartAdds = Number(row?.cartAdds ?? 0);
  const checkoutStarts = Number(row?.checkoutStarts ?? 0);
  const completedOrders = Number(row?.completedOrders ?? 0);
  return {
    productViews, cartAdds, checkoutStarts, completedOrders,
    viewToCartRate: productViews > 0 ? cartAdds / productViews : 0,
    cartToCheckoutRate: cartAdds > 0 ? checkoutStarts / cartAdds : 0,
    checkoutToOrderRate: checkoutStarts > 0 ? completedOrders / checkoutStarts : 0,
  };
}
