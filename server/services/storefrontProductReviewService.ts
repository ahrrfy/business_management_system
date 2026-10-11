import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { customers, onlineOrderItems, onlineOrders, productVariants, products, storefrontProductReviews, users } from "../../drizzle/schema";
import { appErrorMessage } from "../../shared/errors";
import { getDb } from "../db";
import { extractInsertId } from "../lib/insertId";
import { normalizeIraqPhoneE164 } from "../lib/phone";
import { createAppNotification } from "./appNotificationService";

function cleanComment(value: string) {
  const comment = value.trim().replace(/\s+/g, " ");
  if (comment.length < 8 || comment.length > 1000) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "طول نص المراجعة غير مناسب",
        why: `عدد الأحرف الحالي ${comment.length} حرفاً، بينما المطلوب بين 8 و 1000 حرف`,
        doThis: "اكتب تجربة مفيدة ومفصلة عن المنتج بما لا يقل عن 8 أحرف",
      }),
    });
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
      onlineOrderId: storefrontProductReviews.onlineOrderId,
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
      reviewerName: row.reviewerName ? maskReviewerName(row.reviewerName) : "متسوق موثق",
      isVerifiedPurchase: Boolean(row.onlineOrderId != null),
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
  if (!deliveredOrder) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "لا يمكن إرسال مراجعة موثقة",
        why: "لم يتم العثور على طلب مُسلّم ومكتمل يتضمن هذا المنتج في حسابك",
        doThis: "يمكنك كتابة مراجعتك بعد استلام الشحنة وتأكيد تسليم الطلب",
      }),
    });
  }
  try {
    const inserted = await db.insert(storefrontProductReviews).values({ productId: input.productId, customerId: input.customerId, onlineOrderId: Number(deliveredOrder.id), rating: input.rating, comment: cleanComment(input.comment), status: "PENDING" });
    const reviewId = extractInsertId(inserted);
    void notifyManagersAboutReview(db, reviewId, input.rating, "عميل موثق");
    return { ok: true as const, status: "PENDING" as const };
  } catch (error) {
    if (String(error).includes("uq_storefront_review_order_product") || String(error).includes("Duplicate")) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "مراجعة مكررة لنفس الطلب",
          why: "سبق أن أرسلت مراجعتك لهذا المنتج من هذا الطلب المسلم",
          doThis: "يمكنك مراجعة منتج آخر أو تعديل مراجعتك الحالية بالتواصل مع الدعم",
        }),
      });
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

  const publishableProduct = (
    await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, input.productId), eq(products.isActive, true), eq(products.showInStore, true)))
      .limit(1)
  )[0];
  if (!publishableProduct) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "المنتج غير متاح للتقييم",
        why: "المنتج المطلوب غير معروض في المتجر العام حالياً أو تم إيقافه",
        doThis: "تأكد من اختيار منتج منشور ونشط في واجهة المتجر لإضافة تقييمك",
      }),
    });
  }

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

  let normalizedPhone: string | null = null;
  if (input.reviewerPhone?.trim()) {
    normalizedPhone = normalizeIraqPhoneE164(input.reviewerPhone);
  }

  if (input.orderNumber?.trim()) {
    const orderNum = input.orderNumber.trim();
    const verifiedOrder = (
      await db
        .select({
          id: onlineOrders.id,
          customerId: onlineOrders.customerId,
          customerPhone: customers.phone,
          status: onlineOrders.status,
        })
        .from(onlineOrders)
        .innerJoin(customers, eq(onlineOrders.customerId, customers.id))
        .innerJoin(onlineOrderItems, eq(onlineOrderItems.onlineOrderId, onlineOrders.id))
        .innerJoin(productVariants, eq(onlineOrderItems.variantId, productVariants.id))
        .where(
          and(
            eq(onlineOrders.orderNumber, orderNum),
            eq(productVariants.productId, input.productId),
            eq(onlineOrders.status, "DELIVERED"),
          ),
        )
        .limit(1)
    )[0];

    if (verifiedOrder) {
      if (!normalizedPhone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "رقم هاتف الاستلام مطلوب لتوثيق الشراء",
            why: "لتوثيق تقييمك بشارة مشتري موثق، يرجى إدخال نفس رقم هاتف استلام الطلب",
            doThis: "أدخل رقم هاتفك لتأكيد الشراء أو اترك حقل رقم الطلب فارغاً لنشر تقييمك كمتسوق عام",
          }),
        });
      }
      if (verifiedOrder.customerPhone) {
        const orderPhoneNorm = normalizeIraqPhoneE164(verifiedOrder.customerPhone);
        if (orderPhoneNorm && orderPhoneNorm !== normalizedPhone) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "عدم تطابق رقم هاتف الاستلام",
              why: "رقم الهاتف المدخل لا يطابق رقم هاتف العميل المسجل في هذا الطلب",
              doThis: "أدخل نفس رقم الهاتف الذي استلمت به الشحنة أو اترك حقل الطلب فارغاً للتقييم العام",
            }),
          });
        }
      }
      matchedOrderId = Number(verifiedOrder.id);
      matchedCustomerId = Number(verifiedOrder.customerId);

      const existingReview = (
        await db
          .select({ id: storefrontProductReviews.id })
          .from(storefrontProductReviews)
          .where(
            and(
              eq(storefrontProductReviews.onlineOrderId, matchedOrderId),
              eq(storefrontProductReviews.productId, input.productId),
            ),
          )
          .limit(1)
      )[0];
      if (existingReview) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تقييم مكرر لنفس الطلب",
            why: "سبق تسجيل تقييم معتمد لهذا المنتج من نفس رقم الطلب",
            doThis: "يمكنك كتابة مراجعة لمنتج آخر في الطلب أو تحديث مراجعتك عبر خدمة العملاء",
          }),
        });
      }
    } else {
      const orderExists = (
        await db
          .select({ id: onlineOrders.id, status: onlineOrders.status })
          .from(onlineOrders)
          .where(eq(onlineOrders.orderNumber, orderNum))
          .limit(1)
      )[0];
      if (orderExists) {
        if (orderExists.status !== "DELIVERED") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "الطلب غير مكتمل التسليم",
              why: "يمكن توثيق شارة الشراء المؤكد فقط بعد استلام الشحنة وتأكيد التسليم",
              doThis: "انتظر حتى تستلم الشحنة لتسجيل مراجعة موثقة أو اترك رقم الطلب فارغاً للمراجعة العامة",
            }),
          });
        } else {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "المنتج غير موجود بالطلب",
              why: "رقم الطلب المدخل لا يتضمن هذا المنتج المحدد",
              doThis: "تأكد من اختيار صفحة المنتج الصحيح الذي طلبته أو راجع قائمة طلباتك",
            }),
          });
        }
      } else {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "رقم الطلب غير موجود",
            why: "لم يتم العثور على طلب مسجل بهذا الرقم في النظام",
            doThis: "تحقق من رقم الطلب كما ورد في رسالة التأكيد أو الفاتورة (مثال: ORD-...) أو اتركه فارغاً",
          }),
        });
      }
    }
  }

  if (!matchedCustomerId && (normalizedPhone || input.reviewerPhone?.trim())) {
    const rawTrimmed = input.reviewerPhone?.trim();
    const phoneConds = [];
    if (normalizedPhone) {
      phoneConds.push(
        eq(customers.phone, normalizedPhone),
        eq(customers.phone2, normalizedPhone),
        eq(customers.phone3, normalizedPhone),
        eq(customers.whatsapp, normalizedPhone)
      );
    }
    if (rawTrimmed && rawTrimmed !== normalizedPhone) {
      phoneConds.push(
        eq(customers.phone, rawTrimmed),
        eq(customers.phone2, rawTrimmed),
        eq(customers.phone3, rawTrimmed),
        eq(customers.whatsapp, rawTrimmed)
      );
    }
    const foundCustomer = (await db
      .select({ id: customers.id })
      .from(customers)
      .where(or(...phoneConds))
      .limit(1))[0];
    if (foundCustomer) {
      matchedCustomerId = Number(foundCustomer.id);
    }
  }

  try {
    const inserted = await db.insert(storefrontProductReviews).values({
      productId: input.productId,
      customerId: matchedCustomerId,
      onlineOrderId: matchedOrderId,
      reviewerName: cleanName,
      reviewerPhone: normalizedPhone ?? (input.reviewerPhone?.trim() || null),
      rating: input.rating,
      comment,
      status: "PENDING",
    });

    const reviewId = extractInsertId(inserted);
    void notifyManagersAboutReview(db, reviewId, input.rating, cleanName);

    return { ok: true as const, status: "PENDING" as const };
  } catch (error) {
    if (String(error).includes("uq_storefront_review_order_product") || String(error).includes("Duplicate")) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تقييم مكرر لنفس الطلب",
          why: "سبق تسجيل تقييم معتمد لهذا المنتج من نفس رقم الطلب",
          doThis: "يمكنك كتابة مراجعة لمنتج آخر في الطلب أو تحديث مراجعتك عبر خدمة العملاء",
        }),
      });
    }
    throw error;
  }
}

