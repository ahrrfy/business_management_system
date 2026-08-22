import { TRPCError } from "@trpc/server";
import { and, desc, eq, or, sql } from "drizzle-orm";

import { onlineOrderItems, onlineOrders, productVariants, storefrontProductReviews, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { createAppNotification } from "./appNotificationService";

function cleanComment(value: string) {
  const comment = value.trim().replace(/\s+/g, " ");
  if (comment.length < 8 || comment.length > 1000) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب مراجعة من 8 إلى 1000 حرف" });
  }
  return comment;
}

/** لا تظهر علناً إلا مراجعات اعتمدها المتجر، ولا نعيد اسم العميل لحماية الخصوصية. */
export async function listStorefrontProductReviews(productId: number) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });
  const rows = await db
    .select({ id: storefrontProductReviews.id, rating: storefrontProductReviews.rating, comment: storefrontProductReviews.comment, createdAt: storefrontProductReviews.createdAt })
    .from(storefrontProductReviews)
    .where(and(eq(storefrontProductReviews.productId, productId), eq(storefrontProductReviews.status, "APPROVED")))
    .orderBy(desc(storefrontProductReviews.createdAt))
    .limit(20);
  const aggregate = (await db
    .select({ count: sql<number>`COUNT(*)`, average: sql<string>`COALESCE(AVG(${storefrontProductReviews.rating}), 0)` })
    .from(storefrontProductReviews)
    .where(and(eq(storefrontProductReviews.productId, productId), eq(storefrontProductReviews.status, "APPROVED"))))[0];
  return { summary: { count: Number(aggregate?.count ?? 0), average: Number(aggregate?.average ?? 0) }, items: rows.map((row) => ({ id: Number(row.id), rating: Number(row.rating), comment: row.comment, createdAt: row.createdAt })) };
}

/** يقبل مراجعة واحدة للمنتج في كل طلب مُسلّم من مالك جلسة الهاتف المتحققة. */
export async function submitStorefrontProductReview(input: { customerId: number; productId: number; rating: number; comment: string }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });
  const deliveredOrder = (await db
    .select({ id: onlineOrders.id })
    .from(onlineOrders)
    .innerJoin(onlineOrderItems, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .where(and(eq(onlineOrders.customerId, input.customerId), eq(onlineOrders.status, "DELIVERED"), eq(productVariants.productId, input.productId)))
    .orderBy(desc(onlineOrders.orderDate))
    .limit(1))[0];
  if (!deliveredOrder) throw new TRPCError({ code: "FORBIDDEN", message: "يمكن إرسال مراجعة بعد استلام طلب يتضمن هذا المنتج" });
  try {
    const inserted = await db.insert(storefrontProductReviews).values({ productId: input.productId, customerId: input.customerId, onlineOrderId: Number(deliveredOrder.id), rating: input.rating, comment: cleanComment(input.comment), status: "PENDING" });
    const reviewId = extractInsertId(inserted);
    const recipients = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isActive, true), or(eq(users.role, "admin"), eq(users.role, "manager"))));
    void Promise.all(recipients.map((recipient) => createAppNotification({
      userId: Number(recipient.id),
      kind: "APPROVAL_REQUIRED",
      title: "مراجعة منتج جديدة",
      body: "هناك مراجعة موثقة بانتظار اعتمادها في المتجر.",
      route: "/store?tab=reviews",
      eventKey: `storefront-product-review:${reviewId}:user:${recipient.id}`,
      entityType: "storefrontProductReview",
      entityId: reviewId,
      requiresAction: true,
      push: true,
    }))).catch(() => undefined);
    return { ok: true as const, status: "PENDING" as const };
  } catch (error) {
    if (String(error).includes("uq_storefront_review_order_product") || String(error).includes("Duplicate")) {
      throw new TRPCError({ code: "CONFLICT", message: "سبق أن أرسلت مراجعتك لهذا المنتج من هذا الطلب" });
    }
    throw error;
  }
}
