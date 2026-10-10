import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { customers, onlineOrderItems, onlineOrders, productVariants, storefrontProductReviews, users } from "../../drizzle/schema";
import { appErrorMessage } from "../../shared/errors";
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

function maskReviewerName(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0]}.`;
}

/** لا تظهر علناً إلا مراجعات اعتمدها المتجر، ولا نعيد اسم العميل الكامل لحماية الخصوصية. */
export async function listStorefrontProductReviews(productId: number) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });
  const rows = await db
    .select({
      id: storefrontProductReviews.id,
      rating: storefrontProductReviews.rating,
      comment: storefrontProductReviews.comment,
      reviewerName: storefrontProductReviews.reviewerName,
      createdAt: storefrontProductReviews.createdAt,
    })
    .from(storefrontProductReviews)
    .where(and(eq(storefrontProductReviews.productId, productId), eq(storefrontProductReviews.status, "APPROVED")))
    .orderBy(desc(storefrontProductReviews.createdAt))
    .limit(20);
  const aggregate = (await db
    .select({ count: sql<number>`COUNT(*)`, average: sql<string>`COALESCE(AVG(${storefrontProductReviews.rating}), 0)` })
    .from(storefrontProductReviews)
    .where(and(eq(storefrontProductReviews.productId, productId), eq(storefrontProductReviews.status, "APPROVED"))))[0];
  return {
    summary: { count: Number(aggregate?.count ?? 0), average: Number(aggregate?.average ?? 0) },
    items: rows.map((row) => ({
      id: Number(row.id),
      rating: Number(row.rating),
      comment: row.comment,
      reviewerName: row.reviewerName ? "متسوق موثق" : "عميل موثق",
      createdAt: row.createdAt,
    })),
  };
}

async function notifyManagersAboutReview(db: NonNullable<ReturnType<typeof getDb>>, reviewId: number, rating: number, reviewerDisplay: string) {
  try {
    const recipients = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isActive, true), or(eq(users.role, "admin"), eq(users.role, "manager"))));

    await Promise.all(recipients.map((recipient) => createAppNotification({
      userId: Number(recipient.id),
      kind: "APPROVAL_REQUIRED",
      title: "مراجعة منتج جديدة بانتظار الاعتماد",
      body: `وصل تقييم جديد (${rating} نجوم) من ${reviewerDisplay} بانتظار الاعتماد في المتجر.`,
      route: "/store-admin?tab=reviews",
      eventKey: `storefront-review:${reviewId}:user:${recipient.id}`,
      entityType: "storefrontProductReview",
      entityId: reviewId,
      requiresAction: true,
      push: true,
    })));
  } catch {
    // Best-effort notification; do not fail the persisted review
  }
}

/** يقبل مراجعة واحدة للمنتج في كل طلب مُسلّم من مالك جلسة الهاتف المتحققة. */
export async function submitStorefrontProductReview(input: { customerId: number; productId: number; rating: number; comment: string }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });
  // لا نلتقط «آخر طلب» فقط: قد يكون العميل قد قيّمه سابقاً بينما يملك طلباً مُسلّماً
  // أقدم لم يقيّمه بعد. الـLEFT JOIN يحافظ على عقد «مراجعة واحدة لكل منتج×طلب» بلا
  // حرمان العميل من تجربة شراء موثقة أخرى.
  const deliveredOrder = (await db
    .select({ id: onlineOrders.id })
    .from(onlineOrders)
    .innerJoin(onlineOrderItems, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
    .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
    .leftJoin(storefrontProductReviews, and(
      eq(storefrontProductReviews.onlineOrderId, onlineOrders.id),
      eq(storefrontProductReviews.productId, input.productId),
    ))
    .where(and(
      eq(onlineOrders.customerId, input.customerId),
      eq(onlineOrders.status, "DELIVERED"),
      eq(productVariants.productId, input.productId),
      isNull(storefrontProductReviews.id),
    ))
    .orderBy(desc(onlineOrders.orderDate))
    .limit(1))[0];
  if (!deliveredOrder) throw new TRPCError({ code: "FORBIDDEN", message: "يمكن إرسال مراجعة بعد استلام طلب يتضمن هذا المنتج" });
  try {
    const inserted = await db.insert(storefrontProductReviews).values({ productId: input.productId, customerId: input.customerId, onlineOrderId: Number(deliveredOrder.id), rating: input.rating, comment: cleanComment(input.comment), status: "PENDING" });
    const reviewId = extractInsertId(inserted);
    void notifyManagersAboutReview(db, reviewId, input.rating, "عميل موثق");
    return { ok: true as const, status: "PENDING" as const };
  } catch (error) {
    if (String(error).includes("uq_storefront_review_order_product") || String(error).includes("Duplicate")) {
      throw new TRPCError({ code: "CONFLICT", message: "سبق أن أرسلت مراجعتك لهذا المنتج من هذا الطلب" });
    }
    throw error;
  }
}

/** يقبل تقييماً ومراجعة من متسوقي وزوار المتجر العام؛ تدخل المراجعة طابور الاعتماد بانتظار موافقة الإدارة. */
export async function submitPublicStorefrontReview(input: {
  productId: number;
  rating: number;
  reviewerName: string;
  reviewerPhone?: string | null;
  orderNumber?: string | null;
  comment: string;
}) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة بيانات المتجر غير متاحة" });
  if (input.rating < 1 || input.rating > 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "قيمة التقييم غير مقبولة",
        why: `القيمة المدخلة ${input.rating} بينما المقياس المعتمد من 1 إلى 5 نجوم`,
        doThis: "اختر عدداً من النجوم بين 1 و 5 لتقييم المنتج",
      }),
    });
  }
  const cleanName = input.reviewerName.trim().slice(0, 100);
  if (cleanName.length < 2) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "اسم كاتب التقييم قصير جداً",
        why: `الاسم المدخل يتكون من ${cleanName.length} حرفاً فقط`,
        doThis: "اكتب اسمك الصريح أو كنيتك بحرفين على الأقل لتظهر مراجعتك",
      }),
    });
  }
  const comment = cleanComment(input.comment);

  let matchedCustomerId: number | null = null;
  let matchedOrderId: number | null = null;

  if (input.orderNumber?.trim()) {
    const foundOrder = (await db
      .select({ id: onlineOrders.id, customerId: onlineOrders.customerId })
      .from(onlineOrders)
      .where(eq(onlineOrders.orderNumber, input.orderNumber.trim()))
      .limit(1))[0];
    if (foundOrder) {
      matchedOrderId = Number(foundOrder.id);
      matchedCustomerId = Number(foundOrder.customerId);
    }
  }

  if (!matchedCustomerId && input.reviewerPhone?.trim()) {
    const cleanPhone = input.reviewerPhone.trim();
    const foundCustomer = (await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.phone, cleanPhone))
      .limit(1))[0];
    if (foundCustomer) {
      matchedCustomerId = Number(foundCustomer.id);
    }
  }

  const inserted = await db.insert(storefrontProductReviews).values({
    productId: input.productId,
    customerId: matchedCustomerId,
    onlineOrderId: matchedOrderId,
    reviewerName: cleanName,
    reviewerPhone: input.reviewerPhone?.trim() || null,
    rating: input.rating,
    comment,
    status: "PENDING",
  });

  const reviewId = extractInsertId(inserted);
  void notifyManagersAboutReview(db, reviewId, input.rating, cleanName);

  return { ok: true as const, status: "PENDING" as const };
}

