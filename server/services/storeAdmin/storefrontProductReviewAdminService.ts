import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";

import { customers, products, storefrontProductReviews } from "../../../drizzle/schema";
import { appErrorMessage } from "../../../shared/errors";
import { getDb } from "../../db";
import { withTx } from "../tx";

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
  return withTx(async (tx) => {
    // القفل يجعل القرار الواحد نهائياً: لا يستطيع طلب API متأخر أن يقلب مراجعة منشورة
    // أو مرفوضة بعد أن حسمها موظف آخر.
    const review = (await tx.select({ status: storefrontProductReviews.status }).from(storefrontProductReviews)
      .where(eq(storefrontProductReviews.id, input.reviewId)).for("update").limit(1))[0];
    if (!review) throw new TRPCError({ code: "NOT_FOUND", message: "المراجعة غير موجودة" });
    if (review.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لا يمكن تعديل قرار المراجعة",
          why: "المراجعة حُسمت سابقاً ولا تعود إلى طابور الاعتماد",
          doThis: "راجع سجل التدقيق أو أنشئ ملاحظة متابعة للعميل عند الحاجة",
        }),
      });
    }
    await tx.update(storefrontProductReviews).set({ status: input.status, moderatedAt: new Date() })
      .where(eq(storefrontProductReviews.id, input.reviewId));
    return { ok: true as const };
  });
}
