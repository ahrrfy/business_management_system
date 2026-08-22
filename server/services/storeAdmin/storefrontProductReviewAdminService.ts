import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";

import { customers, products, storefrontProductReviews } from "../../../drizzle/schema";
import { getDb } from "../../db";

export async function listStorefrontProductReviewsForAdmin(status: "PENDING" | "APPROVED" | "REJECTED") {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });
  const rows = await db
    .select({
      id: storefrontProductReviews.id,
      productId: storefrontProductReviews.productId,
      productName: products.name,
      customerName: customers.name,
      rating: storefrontProductReviews.rating,
      comment: storefrontProductReviews.comment,
      status: storefrontProductReviews.status,
      createdAt: storefrontProductReviews.createdAt,
    })
    .from(storefrontProductReviews)
    .innerJoin(products, eq(storefrontProductReviews.productId, products.id))
    .innerJoin(customers, eq(storefrontProductReviews.customerId, customers.id))
    .where(eq(storefrontProductReviews.status, status))
    .orderBy(desc(storefrontProductReviews.createdAt))
    .limit(100);
  return rows.map((row) => ({ ...row, id: Number(row.id), productId: Number(row.productId), rating: Number(row.rating) }));
}

export async function moderateStorefrontProductReview(input: { reviewId: number; status: "APPROVED" | "REJECTED" }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });
  const updated = await db.update(storefrontProductReviews)
    .set({ status: input.status, moderatedAt: new Date() })
    .where(eq(storefrontProductReviews.id, input.reviewId));
  if (Number((updated as { rowsAffected?: number }).rowsAffected ?? 0) < 1) throw new TRPCError({ code: "NOT_FOUND", message: "المراجعة غير موجودة" });
  return { ok: true as const };
}
