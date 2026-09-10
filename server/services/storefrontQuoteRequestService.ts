/**
 * استفسارات عروض سعر المتجر. هذا المسار متعمّد أن يكون بلا تسعير أو حجز مخزون أو سند مالي:
 * يلتقط حاجة الشركات/الكميات/الطباعة، ثم ينشئ الموظف العرض الرسمي بعد مراجعة التوفر والتخصيص.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  productUnits,
  productVariants,
  products,
  storefrontQuoteRequestItems,
  storefrontQuoteRequests,
  quotations,
} from "../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { retryOnDup } from "../lib/retryDup";
import {
  buildStorefrontGuestTrackingToken,
  hashStorefrontGuestTrackingToken,
  parseAndVerifyStorefrontGuestTrackingToken,
} from "../lib/storefrontGuestTracking";
import { money } from "./money";
import {
  lockOrCreateOnlineCustomer,
  normalizeStorePhone,
} from "./onlineOrderService";
import { requireStorefrontContext } from "./storefrontContextService";
import { withTx } from "./tx";

export type StorefrontQuoteRequestType =
  | "BULK"
  | "CUSTOM_PRINT"
  | "BUSINESS"
  | "GENERAL";
export type StorefrontQuoteContactPreference = "PHONE" | "WHATSAPP";

const QUOTE_REQUEST_GUEST_TRACKING_TTL_SECONDS = 60 * 60 * 24 * 30;
const QUOTE_REQUEST_GUEST_TRACKING_DOMAIN = "STORE_QUOTE_REQUEST_TRACKING_V1";

export interface CreateStorefrontQuoteRequestInput {
  customerName: string;
  customerPhone: string;
  companyName?: string | null;
  governorate?: string | null;
  contactPreference: StorefrontQuoteContactPreference;
  requestType: StorefrontQuoteRequestType;
  note: string;
  clientRequestId: string;
  lines: Array<{ productUnitId: number; quantity: number }>;
  authenticatedCustomer?: { customerId: number; phone: string } | null;
}

export interface StorefrontQuoteRequestTracking {
  requestNumber: string;
  status: "PENDING" | "CONTACTED" | "QUOTED" | "CLOSED" | "CANCELLED";
  requestType: StorefrontQuoteRequestType;
  companyName: string | null;
  governorate: string | null;
  contactPreference: StorefrontQuoteContactPreference;
  /** مرجع العرض الرسمي فقط؛ لا تُكشف الأسعار أو البنود المسعّرة عبر التتبع. */
  officialQuotation: {
    quoteNumber: string;
    validUntil: Date | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    productName: string;
    variantLabel: string | null;
    unitName: string;
    quantity: number;
  }>;
}

type QuoteRequestGuestTrackingSnapshot = {
  id: number;
  requestNumber: string;
  guestTrackingPublicId: string | null;
  guestTrackingTokenHash: string | null;
  guestTrackingExpiresAt: Date | null;
};

function quoteRequestGuestTrackingResult(
  request: QuoteRequestGuestTrackingSnapshot,
  idempotentReplay: boolean,
): {
  requestId: number;
  requestNumber: string;
  guestTrackingToken: string | null;
  guestTrackingExpiresAt: Date | null;
  idempotentReplay: boolean;
} {
  let guestTrackingToken: string | null = null;
  if (
    request.guestTrackingPublicId &&
    request.guestTrackingTokenHash &&
    request.guestTrackingExpiresAt
  ) {
    const rebuilt = buildStorefrontGuestTrackingToken(
      QUOTE_REQUEST_GUEST_TRACKING_DOMAIN,
      request.guestTrackingPublicId,
      request.guestTrackingExpiresAt,
    );
    if (
      hashStorefrontGuestTrackingToken(rebuilt) !==
      request.guestTrackingTokenHash
    ) {
      throw new Error("Storefront quote request tracking token snapshot is inconsistent");
    }
    guestTrackingToken = rebuilt;
  }
  return {
    requestId: request.id,
    requestNumber: request.requestNumber,
    guestTrackingToken,
    guestTrackingExpiresAt: request.guestTrackingExpiresAt,
    idempotentReplay,
  };
}

function normalizeLines(
  lines: CreateStorefrontQuoteRequestInput["lines"],
): Array<{ productUnitId: number; quantity: number }> {
  const byUnit = new Map<number, number>();
  for (const line of lines) {
    const unitId = Number(line.productUnitId);
    const quantity = Math.floor(Number(line.quantity));
    if (
      !Number.isSafeInteger(unitId) ||
      unitId <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > 10_000
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال طلب عرض السعر",
          why: "توجد كمية أو وحدة منتج غير صالحة في الطلب",
          doThis: "حدّث السلّة وتأكد من الكميات ثم أرسل الطلب من جديد",
        }),
      });
    }
    byUnit.set(unitId, (byUnit.get(unitId) ?? 0) + quantity);
  }
  const normalized = Array.from(byUnit, ([productUnitId, quantity]) => ({
    productUnitId,
    quantity,
  })).sort((a, b) => a.productUnitId - b.productUnitId);
  if (!normalized.length || normalized.length > 30) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال طلب عرض السعر",
        why: "يجب أن يحتوي الطلب على منتج واحد إلى 30 منتجاً مختلفاً",
        doThis: "قسّم الطلب الكبير إلى أكثر من طلب عرض سعر ثم أرسله",
      }),
    });
  }
  return normalized;
}

function variantLabel(row: {
  variantName: string | null;
  color: string | null;
  size: string | null;
}): string | null {
  const label = Array.from(
    new Set(
      [row.variantName, row.color, row.size]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ).join(" — ");
  return label || null;
}

async function loadRequestItems(
  tx: Tx,
  lines: Array<{ productUnitId: number; quantity: number }>,
) {
  const rows = await tx
    .select({
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      unitActive: productUnits.isActive,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      variantActive: productVariants.isActive,
      productName: products.name,
      productActive: products.isActive,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productUnits.id, lines.map((line) => line.productUnitId)));
  const byUnit = new Map(rows.map((row) => [Number(row.productUnitId), row]));
  return lines.map((line) => {
    const row = byUnit.get(line.productUnitId);
    if (!row || !row.productActive || !row.variantActive || !row.unitActive) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال طلب عرض السعر",
          why: "أحد المنتجات التي اخترتها لم يعد متاحاً في الكتالوج",
          doThis: "حدّث السلّة واحذف الصنف غير المتاح، أو اكتب احتياجك في ملاحظات الطلب",
        }),
      });
    }
    const baseQuantity = money(line.quantity).times(row.conversionFactor ?? 1);
    if (!baseQuantity.isInteger() || !baseQuantity.gt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إرسال طلب عرض السعر",
          why: "وحدة أحد المنتجات غير مضبوطة لحساب الكمية",
          doThis: "اكتب احتياجك في ملاحظات الطلب وسيراجعه فريق المكتبة معك",
        }),
      });
    }
    return {
      productUnitId: line.productUnitId,
      productName: row.productName,
      variantLabel: variantLabel(row),
      unitName: row.unitName,
      quantity: line.quantity,
      baseQuantity: baseQuantity.toNumber(),
    };
  });
}

type QuoteRequestTrackingHeader = {
  id: number;
  requestNumber: string;
  status: StorefrontQuoteRequestTracking["status"];
  requestType: StorefrontQuoteRequestType;
  companyName: string | null;
  governorate: string | null;
  contactPreference: StorefrontQuoteContactPreference;
  officialQuotationId: number | null;
  officialQuoteNumber: string | null;
  officialQuoteValidUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function quoteRequestTrackingHeaderSelection() {
  return {
    id: storefrontQuoteRequests.id,
    requestNumber: storefrontQuoteRequests.requestNumber,
    status: storefrontQuoteRequests.status,
    requestType: storefrontQuoteRequests.requestType,
    companyName: storefrontQuoteRequests.companyName,
    governorate: storefrontQuoteRequests.governorate,
    contactPreference: storefrontQuoteRequests.contactPreference,
    officialQuotationId: storefrontQuoteRequests.officialQuotationId,
    officialQuoteNumber: quotations.quoteNumber,
    officialQuoteValidUntil: quotations.validUntil,
    createdAt: storefrontQuoteRequests.createdAt,
    updatedAt: storefrontQuoteRequests.updatedAt,
  };
}

async function buildStorefrontQuoteRequestTracking(
  db: NonNullable<ReturnType<typeof getDb>>,
  request: QuoteRequestTrackingHeader,
): Promise<StorefrontQuoteRequestTracking> {
  const items = await db
    .select({
      productName: storefrontQuoteRequestItems.productName,
      variantLabel: storefrontQuoteRequestItems.variantLabel,
      unitName: storefrontQuoteRequestItems.unitName,
      quantity: storefrontQuoteRequestItems.quantity,
    })
    .from(storefrontQuoteRequestItems)
    .where(eq(storefrontQuoteRequestItems.quoteRequestId, request.id));
  return {
    requestNumber: request.requestNumber,
    status: request.status,
    requestType: request.requestType,
    companyName: request.companyName ?? null,
    governorate: request.governorate ?? null,
    contactPreference: request.contactPreference,
    officialQuotation: request.officialQuotationId && request.officialQuoteNumber
      ? {
          quoteNumber: request.officialQuoteNumber,
          validUntil: request.officialQuoteValidUntil,
        }
      : null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    items: items.map((item) => ({
      productName: item.productName,
      variantLabel: item.variantLabel ?? null,
      unitName: item.unitName,
      quantity: Number(item.quantity),
    })),
  };
}

function quoteRequestTrackingUnavailableError(): TRPCError {
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: appErrorMessage({
      what: "تعذّر عرض طلب عرض السعر الآن",
      why: "خدمة طلبات المبيعات غير متاحة مؤقتاً — لم يتغير طلبك",
      doThis: "أعد المحاولة بعد دقائق، وإن استمرّ الأمر فتواصل مع المكتبة",
    }),
  });
}

function quoteRequestTrackingNotFoundError(): TRPCError {
  return new TRPCError({
    code: "NOT_FOUND",
    message: appErrorMessage({
      what: "تعذّر عرض طلب عرض السعر",
      why: "لا يوجد طلب متاح بهذه الصلاحية، أو انتهت صلاحية رمز التتبع",
      doThis: "افتح الطلب من الجهاز الذي أرسلته منه أو سجّل الدخول بالحساب المرتبط به ثم أعد المحاولة",
    }),
  });
}

/** المالك الموثق يستعمل رقم SRQ مرجعاً فقط؛ العزل الحقيقي بالـ customerId الموقّع. */
export async function trackStorefrontQuoteRequestForCustomer(
  requestNumber: string,
  customerId: number,
): Promise<StorefrontQuoteRequestTracking> {
  const db = getDb();
  if (!db) throw quoteRequestTrackingUnavailableError();
  const request = (
    await db
      .select(quoteRequestTrackingHeaderSelection())
      .from(storefrontQuoteRequests)
      .leftJoin(quotations, eq(quotations.id, storefrontQuoteRequests.officialQuotationId))
      .where(
        and(
          eq(storefrontQuoteRequests.requestNumber, requestNumber.trim().toUpperCase()),
          eq(storefrontQuoteRequests.customerId, customerId),
        ),
      )
      .limit(1)
  )[0];
  if (!request) throw quoteRequestTrackingNotFoundError();
  return buildStorefrontQuoteRequestTracking(db, request);
}

/** الضيف لا يرسل SRQ أو هاتفاً: الرمز الموقّع المنتهي هو صلاحية التتبع الوحيدة. */
export async function trackStorefrontQuoteRequestByGuestToken(
  token: string,
): Promise<StorefrontQuoteRequestTracking> {
  const verified = parseAndVerifyStorefrontGuestTrackingToken(
    QUOTE_REQUEST_GUEST_TRACKING_DOMAIN,
    token,
  );
  if (!verified) throw quoteRequestTrackingNotFoundError();
  const db = getDb();
  if (!db) throw quoteRequestTrackingUnavailableError();
  const request = (
    await db
      .select({
        ...quoteRequestTrackingHeaderSelection(),
        guestTrackingExpiresAt: storefrontQuoteRequests.guestTrackingExpiresAt,
      })
      .from(storefrontQuoteRequests)
      .leftJoin(quotations, eq(quotations.id, storefrontQuoteRequests.officialQuotationId))
      .where(
        and(
          eq(storefrontQuoteRequests.guestTrackingPublicId, verified.publicId),
          eq(storefrontQuoteRequests.guestTrackingTokenHash, verified.tokenHash),
          sql`${storefrontQuoteRequests.guestTrackingExpiresAt} > CURRENT_TIMESTAMP(3)`,
        ),
      )
      .limit(1)
  )[0];
  const storedExpirySeconds = request?.guestTrackingExpiresAt
    ? Math.floor(request.guestTrackingExpiresAt.getTime() / 1000)
    : null;
  if (!request || storedExpirySeconds !== verified.expiresAtSeconds) {
    throw quoteRequestTrackingNotFoundError();
  }
  return buildStorefrontQuoteRequestTracking(db, request);
}

export async function createStorefrontQuoteRequest(
  input: CreateStorefrontQuoteRequestInput,
): Promise<{
  requestId: number;
  requestNumber: string;
  guestTrackingToken: string | null;
  guestTrackingExpiresAt: Date | null;
  idempotentReplay: boolean;
}> {
  // قد تصل نقرتان بالمعرّف نفسه قبل التزام الأولى؛ القيد الفريد هو الحكم، وإعادة المحاولة
  // تجعل الثانية تقرأ الطلب الفائز بدلاً من تحويل إعادة الإرسال الطبيعية إلى خطأ للمستخدم.
  return retryOnDup(() => createStorefrontQuoteRequestAttempt(input));
}

async function createStorefrontQuoteRequestAttempt(
  input: CreateStorefrontQuoteRequestInput,
): Promise<{
  requestId: number;
  requestNumber: string;
  guestTrackingToken: string | null;
  guestTrackingExpiresAt: Date | null;
  idempotentReplay: boolean;
}> {
  const name = input.customerName.trim();
  const phone = normalizeStorePhone(input.customerPhone);
  const note = input.note.trim();
  const clientRequestId = input.clientRequestId.trim();
  if (!name || !note || !clientRequestId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إرسال طلب عرض السعر",
        why: "بيانات التواصل أو وصف الاحتياج غير مكتملة",
        doThis: "أدخل الاسم ورقم الهاتف ووصفاً مختصراً لما تحتاجه ثم أعد الإرسال",
      }),
    });
  }
  const lines = normalizeLines(input.lines);
  return withTx(async (tx) => {
    // الطلب التجاري يبقى متاحاً حتى عند إغلاق البيع المباشر، لكن لا يقبل فرعاً غائباً أو معطلاً.
    const storefront = await requireStorefrontContext(tx, {
      requireOpen: false,
      lock: true,
      branchLock: "share",
    });
    const customerId = await lockOrCreateOnlineCustomer(
      tx,
      phone,
      name,
      input.authenticatedCustomer,
    );
    const replay = (
      await tx
        .select({
          id: storefrontQuoteRequests.id,
          requestNumber: storefrontQuoteRequests.requestNumber,
          customerId: storefrontQuoteRequests.customerId,
          guestTrackingPublicId: storefrontQuoteRequests.guestTrackingPublicId,
          guestTrackingTokenHash: storefrontQuoteRequests.guestTrackingTokenHash,
          guestTrackingExpiresAt: storefrontQuoteRequests.guestTrackingExpiresAt,
        })
        .from(storefrontQuoteRequests)
        .where(eq(storefrontQuoteRequests.clientRequestId, clientRequestId))
        .for("update")
        .limit(1)
    )[0];
    if (replay) {
      if (Number(replay.customerId) !== customerId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إرسال طلب عرض السعر",
            why: "رمز الإرسال هذا مستعمل لطلب عميل آخر",
            doThis: "حدّث الصفحة ثم أعد الإرسال، وسيُنشأ رمز جديد تلقائياً",
          }),
        });
      }
      return quoteRequestGuestTrackingResult(
        {
          id: Number(replay.id),
          requestNumber: replay.requestNumber,
          guestTrackingPublicId: replay.guestTrackingPublicId,
          guestTrackingTokenHash: replay.guestTrackingTokenHash,
          guestTrackingExpiresAt: replay.guestTrackingExpiresAt,
        },
        true,
      );
    }
    const items = await loadRequestItems(tx, lines);
    const guestTrackingPublicId = randomBytes(16).toString("hex");
    // عمود MySQL timestamp دقته بالثانية هنا؛ نطبّع قبل التوقيع كي لا يقرّب التخزين
    // ثانيةً إلى الأمام فيصبح رمز الضيف الجديد غير مطابق للـ hash المحفوظ.
    const guestTrackingExpiresAt = new Date(
      Math.floor(Date.now() / 1000) * 1000 +
        QUOTE_REQUEST_GUEST_TRACKING_TTL_SECONDS * 1000,
    );
    const guestTrackingToken = buildStorefrontGuestTrackingToken(
      QUOTE_REQUEST_GUEST_TRACKING_DOMAIN,
      guestTrackingPublicId,
      guestTrackingExpiresAt,
    );
    const inserted = await tx.insert(storefrontQuoteRequests).values({
      // clientRequestId يصل إلى 80 حرفاً، بينما requestNumber لا يتجاوز 50. لا نضعه هنا
      // كي لا يفشل الطلب الصحيح؛ الاسم المؤقت لا يظهر للعميل ويُستبدل برقم SRQ داخل المعاملة.
      requestNumber: `TMP-${randomUUID()}`,
      branchId: storefront.branchId,
      customerId,
      requestType: input.requestType,
      companyName: input.companyName?.trim() || null,
      governorate: input.governorate?.trim() || null,
      contactPreference: input.contactPreference,
      customerNote: note,
      clientRequestId,
      guestTrackingPublicId,
      guestTrackingTokenHash: hashStorefrontGuestTrackingToken(guestTrackingToken),
      guestTrackingExpiresAt,
    });
    const requestId = extractInsertId(inserted);
    const requestNumber = `SRQ-${100000 + requestId}`;
    await tx
      .update(storefrontQuoteRequests)
      .set({ requestNumber })
      .where(eq(storefrontQuoteRequests.id, requestId));
    await tx.insert(storefrontQuoteRequestItems).values(
      items.map((item) => ({ quoteRequestId: requestId, ...item })),
    );
    return {
      requestId,
      requestNumber,
      guestTrackingToken,
      guestTrackingExpiresAt,
      idempotentReplay: false,
    };
  });
}
