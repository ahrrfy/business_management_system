/**
 * استفسارات عروض سعر المتجر. هذا المسار متعمّد أن يكون بلا تسعير أو حجز مخزون أو سند مالي:
 * يلتقط حاجة الشركات/الكميات/الطباعة، ثم ينشئ الموظف العرض الرسمي بعد مراجعة التوفر والتخصيص.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  bundleComponents,
  customers,
  productUnits,
  productVariants,
  productPrices,
  products,
  quotationItems,
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
import { baghdadToday } from "./businessDay";
import { money, toDateStr } from "./money";
import { loadVariantAvailability } from "./catalog/variantAvailability";
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
    /** حالة العرض الرسمي فقط؛ يبقى السعر وبنود التسعير خارج مسار التتبع. */
    status: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "CONVERTED" | "EXPIRED";
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
  officialQuoteStatus: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "CONVERTED" | "EXPIRED" | null;
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
    officialQuoteStatus: quotations.status,
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
          status: request.officialQuoteStatus ?? "DRAFT",
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

type OfficialQuotationStatus =
  | "DRAFT"
  | "SENT"
  | "ACCEPTED"
  | "REJECTED"
  | "CONVERTED"
  | "EXPIRED";

export type StorefrontOfficialQuotationAcceptance =
  | {
      outcome: "ACCEPTED";
      quoteNumber: string;
      quoteStatus: "ACCEPTED";
      alreadyAccepted: boolean;
      /** القبول ليس بيعاً: يبقى التجهيز والتحويل قراراً لاحقاً للموظف. */
      nextStep: "STAFF_CONFIRMATION";
    }
  | {
      outcome: "REQUOTE_REQUIRED";
      quoteNumber: string;
      quoteStatus: "SENT" | "EXPIRED";
      reasons: Array<"EXPIRED" | "PRICE_CHANGED" | "UNAVAILABLE">;
      nextStep: "CONTACT_STAFF";
    };

function officialQuotationNotReadyError(): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: appErrorMessage({
      what: "لا يمكن تسجيل الموافقة على العرض الآن",
      why: "العرض الرسمي لم يُرسل بعد، أو أن حالته لم تعد تقبل موافقة جديدة",
      doThis: "حدّث طلب العرض، وانتظر إرسال العرض الرسمي أو تواصل مع فريق المبيعات",
    }),
  });
}

function officialQuotationDataIntegrityError(): TRPCError {
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: appErrorMessage({
      what: "تعذّر تسجيل الموافقة على العرض",
      why: "بيانات العرض الرسمي لا تطابق طلب العرض المرتبط به، لذلك أوقفنا العملية لحماية العميل",
      doThis: "تواصل مع فريق المبيعات برقم طلب العرض ليعيدوا مراجعته وإصدار عرض صحيح",
    }),
  });
}

function reQuoteRequired(
  quoteNumber: string,
  quoteStatus: "SENT" | "EXPIRED",
  reasons: Iterable<"EXPIRED" | "PRICE_CHANGED" | "UNAVAILABLE">,
): StorefrontOfficialQuotationAcceptance {
  return {
    outcome: "REQUOTE_REQUIRED",
    quoteNumber,
    quoteStatus,
    reasons: Array.from(new Set(reasons)),
    nextStep: "CONTACT_STAFF",
  };
}

type LockedQuoteRequestForAcceptance = {
  id: number;
  status: StorefrontQuoteRequestTracking["status"];
  customerId: number | null;
  officialQuotationId: number | null;
};

/**
 * يعيد فحص العرض في نفس المعاملة التي تثبت قبوله. لا ينشئ فاتورة أو طلب متجر أو حجزاً؛
 * القبول إقرار العميل فقط، ثم يقرر الموظف لاحقاً إن كان يحوّله إلى بيع بعد مراجعته النهائية.
 */
async function acceptLockedOfficialQuotation(
  tx: Tx,
  request: LockedQuoteRequestForAcceptance,
): Promise<StorefrontOfficialQuotationAcceptance> {
  if (request.status !== "QUOTED" || request.officialQuotationId == null) {
    throw officialQuotationNotReadyError();
  }

  const quote = (
    await tx
      .select({
        id: quotations.id,
        quoteNumber: quotations.quoteNumber,
        branchId: quotations.branchId,
        customerId: quotations.customerId,
        priceTier: quotations.priceTier,
        validUntil: quotations.validUntil,
        status: quotations.status,
      })
      .from(quotations)
      .where(eq(quotations.id, request.officialQuotationId))
      .for("update")
      .limit(1)
  )[0];
  if (!quote) throw officialQuotationDataIntegrityError();

  const quoteStatus = quote.status as OfficialQuotationStatus;
  if (
    request.customerId == null ||
    quote.customerId == null ||
    Number(request.customerId) !== Number(quote.customerId)
  ) {
    throw officialQuotationDataIntegrityError();
  }
  if (quoteStatus === "ACCEPTED") {
    return {
      outcome: "ACCEPTED",
      quoteNumber: quote.quoteNumber,
      quoteStatus: "ACCEPTED",
      alreadyAccepted: true,
      nextStep: "STAFF_CONFIRMATION",
    };
  }
  if (quoteStatus === "EXPIRED") {
    return reQuoteRequired(quote.quoteNumber, "EXPIRED", ["EXPIRED"] as const);
  }
  if (quoteStatus !== "SENT") throw officialQuotationNotReadyError();

  if (
    quote.validUntil &&
    toDateStr(new Date(quote.validUntil as unknown as string)) < baghdadToday()
  ) {
    // وسم الانتهاء ليس بيعاً ولا حجزاً؛ يمنع تكرار محاولة قبول عرض فات موعده ويعطي الموظف
    // طابوراً صادقاً لإعادة التسعير.
    await tx
      .update(quotations)
      .set({ status: "EXPIRED" })
      .where(eq(quotations.id, Number(quote.id)));
    return reQuoteRequired(quote.quoteNumber, "EXPIRED", ["EXPIRED"] as const);
  }

  const lines = await tx
    .select({
      id: quotationItems.id,
      variantId: quotationItems.variantId,
      productUnitId: quotationItems.productUnitId,
      baseQuantity: quotationItems.baseQuantity,
      unitPrice: quotationItems.unitPrice,
    })
    .from(quotationItems)
    .where(eq(quotationItems.quotationId, Number(quote.id)))
    .orderBy(quotationItems.id)
    .for("update");
  if (!lines.length) {
    return reQuoteRequired(quote.quoteNumber, "SENT", ["UNAVAILABLE"] as const);
  }

  const unitIds = Array.from(
    new Set(lines.map((line) => Number(line.productUnitId))),
  ).sort((a, b) => a - b);
  // السعر وحالة الكتالوج يُقرآن تحت قفل قبل ATP. لا نثق بلقطة العرض عند لحظة القبول:
  // أي تغيير في السعر أو تعطيل وحدة/منتج يعيد العميل للموظف لإصدار عرض جديد واضح.
  const currentCatalogLines = await tx
    .select({
      productUnitId: productUnits.id,
      variantId: productVariants.id,
      unitActive: productUnits.isActive,
      variantActive: productVariants.isActive,
      productActive: products.isActive,
      isBundle: products.isBundle,
      isService: products.isService,
      currentUnitPrice: productPrices.price,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      productPrices,
      and(
        eq(productPrices.productUnitId, productUnits.id),
        eq(productPrices.priceTier, quote.priceTier),
      ),
    )
    .where(inArray(productUnits.id, unitIds))
    .orderBy(productUnits.id)
    .for("update");
  const catalogByUnit = new Map(
    currentCatalogLines.map((line) => [Number(line.productUnitId), line]),
  );

  const reasons = new Set<"EXPIRED" | "PRICE_CHANGED" | "UNAVAILABLE">();
  const stockRequirements = new Map<number, number>();
  const requirementMeta = new Map<number, { isService: boolean }>();
  const bundleDemand = new Map<number, number>();

  for (const line of lines) {
    const catalog = catalogByUnit.get(Number(line.productUnitId));
    if (
      !catalog ||
      Number(catalog.variantId) !== Number(line.variantId) ||
      !catalog.productActive ||
      !catalog.variantActive ||
      !catalog.unitActive
    ) {
      reasons.add("UNAVAILABLE");
      continue;
    }
    if (
      catalog.currentUnitPrice == null ||
      !money(catalog.currentUnitPrice).eq(money(line.unitPrice))
    ) {
      reasons.add("PRICE_CHANGED");
    }
    const baseQuantity = Number(line.baseQuantity);
    if (!Number.isSafeInteger(baseQuantity) || baseQuantity <= 0) {
      reasons.add("UNAVAILABLE");
      continue;
    }
    const variantId = Number(line.variantId);
    if (catalog.isBundle) {
      bundleDemand.set(variantId, (bundleDemand.get(variantId) ?? 0) + baseQuantity);
      continue;
    }
    stockRequirements.set(
      variantId,
      (stockRequirements.get(variantId) ?? 0) + baseQuantity,
    );
    requirementMeta.set(variantId, { isService: catalog.isService === true });
  }

  const bundleIds = Array.from(bundleDemand.keys()).sort((a, b) => a - b);
  if (bundleIds.length) {
    const components = await tx
      .select({
        bundleVariantId: bundleComponents.bundleVariantId,
        componentVariantId: bundleComponents.componentVariantId,
        componentBaseQuantity: bundleComponents.componentBaseQuantity,
        componentVariantActive: productVariants.isActive,
        componentProductActive: products.isActive,
        componentIsService: products.isService,
      })
      .from(bundleComponents)
      .innerJoin(productVariants, eq(bundleComponents.componentVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(bundleComponents.bundleVariantId, bundleIds))
      .orderBy(bundleComponents.bundleVariantId, bundleComponents.componentVariantId)
      .for("update");
    const componentsByBundle = new Map<number, typeof components>();
    for (const component of components) {
      const bundleId = Number(component.bundleVariantId);
      componentsByBundle.set(bundleId, [
        ...(componentsByBundle.get(bundleId) ?? []),
        component,
      ]);
    }
    for (const bundleId of bundleIds) {
      const demand = bundleDemand.get(bundleId) ?? 0;
      const bundleComponentsNow = componentsByBundle.get(bundleId) ?? [];
      if (!bundleComponentsNow.length) {
        reasons.add("UNAVAILABLE");
        continue;
      }
      for (const component of bundleComponentsNow) {
        const requiredPerBundle = Number(component.componentBaseQuantity);
        if (
          !component.componentProductActive ||
          !component.componentVariantActive ||
          !Number.isSafeInteger(requiredPerBundle) ||
          requiredPerBundle <= 0
        ) {
          reasons.add("UNAVAILABLE");
          continue;
        }
        const componentVariantId = Number(component.componentVariantId);
        stockRequirements.set(
          componentVariantId,
          (stockRequirements.get(componentVariantId) ?? 0) + demand * requiredPerBundle,
        );
        requirementMeta.set(componentVariantId, {
          isService: component.componentIsService === true,
        });
      }
    }
  }

  if (stockRequirements.size) {
    const availability = await loadVariantAvailability(
      tx,
      Number(quote.branchId),
      Array.from(stockRequirements.keys()).sort((a, b) => a - b),
      { lock: true },
    );
    for (const [variantId, requiredBase] of Array.from(stockRequirements.entries())) {
      const current = availability.get(variantId);
      const meta = requirementMeta.get(variantId);
      if (
        !current ||
        !meta ||
        current.isBundle ||
        (!meta.isService && requiredBase > current.availableBase)
      ) {
        reasons.add("UNAVAILABLE");
      }
    }
  }

  if (reasons.size) {
    return reQuoteRequired(quote.quoteNumber, "SENT", reasons);
  }

  await tx
    .update(quotations)
    .set({ status: "ACCEPTED" })
    .where(eq(quotations.id, Number(quote.id)));
  return {
    outcome: "ACCEPTED",
    quoteNumber: quote.quoteNumber,
    quoteStatus: "ACCEPTED",
    alreadyAccepted: false,
    nextStep: "STAFF_CONFIRMATION",
  };
}

/** جلسة العميل تحصر طلب SRQ بمعرّف العميل الموقّع؛ الرقم مرجع فقط وليس صلاحية. */
export async function acceptStorefrontOfficialQuotationForCustomer(
  requestNumber: string,
  customerId: number,
): Promise<StorefrontOfficialQuotationAcceptance> {
  return withTx(async (tx) => {
    const request = (
      await tx
        .select({
          id: storefrontQuoteRequests.id,
          status: storefrontQuoteRequests.status,
          customerId: storefrontQuoteRequests.customerId,
          officialQuotationId: storefrontQuoteRequests.officialQuotationId,
        })
        .from(storefrontQuoteRequests)
        .where(
          and(
            eq(storefrontQuoteRequests.requestNumber, requestNumber.trim().toUpperCase()),
            eq(storefrontQuoteRequests.customerId, customerId),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (!request) throw quoteRequestTrackingNotFoundError();
    return acceptLockedOfficialQuotation(tx, {
      id: Number(request.id),
      status: request.status as StorefrontQuoteRequestTracking["status"],
      customerId: request.customerId == null ? null : Number(request.customerId),
      officialQuotationId:
        request.officialQuotationId == null
          ? null
          : Number(request.officialQuotationId),
    });
  });
}

/** رمز الضيف opaque والمنتهي هو صلاحيته الوحيدة لقبول العرض؛ لا يُقبل رقم SRQ هنا. */
export async function acceptStorefrontOfficialQuotationByGuestToken(
  token: string,
): Promise<StorefrontOfficialQuotationAcceptance> {
  const verified = parseAndVerifyStorefrontGuestTrackingToken(
    QUOTE_REQUEST_GUEST_TRACKING_DOMAIN,
    token,
  );
  if (!verified) throw quoteRequestTrackingNotFoundError();
  return withTx(async (tx) => {
    const request = (
      await tx
        .select({
          id: storefrontQuoteRequests.id,
          status: storefrontQuoteRequests.status,
          customerId: storefrontQuoteRequests.customerId,
          officialQuotationId: storefrontQuoteRequests.officialQuotationId,
          guestTrackingExpiresAt: storefrontQuoteRequests.guestTrackingExpiresAt,
        })
        .from(storefrontQuoteRequests)
        .where(
          and(
            eq(storefrontQuoteRequests.guestTrackingPublicId, verified.publicId),
            eq(storefrontQuoteRequests.guestTrackingTokenHash, verified.tokenHash),
            sql`${storefrontQuoteRequests.guestTrackingExpiresAt} > CURRENT_TIMESTAMP(3)`,
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    const storedExpirySeconds = request?.guestTrackingExpiresAt
      ? Math.floor(request.guestTrackingExpiresAt.getTime() / 1000)
      : null;
    if (!request || storedExpirySeconds !== verified.expiresAtSeconds) {
      throw quoteRequestTrackingNotFoundError();
    }
    return acceptLockedOfficialQuotation(tx, {
      id: Number(request.id),
      status: request.status as StorefrontQuoteRequestTracking["status"],
      customerId: request.customerId == null ? null : Number(request.customerId),
      officialQuotationId:
        request.officialQuotationId == null
          ? null
          : Number(request.officialQuotationId),
    });
  });
}

export interface CreateStorefrontQuoteRequestResult {
  requestId: number;
  requestNumber: string;
  guestTrackingToken: string | null;
  guestTrackingExpiresAt: Date | null;
  idempotentReplay: boolean;
}

const QUOTE_REQUEST_KEY_CONFLICT = appErrorMessage({
  what: "تعذّر إرسال طلب عرض السعر",
  why: "رمز الإرسال هذا مستعمل لطلب عميل آخر، ولا نكشف تفاصيل طلبه حمايةً لخصوصيته",
  doThis: "حدّث الصفحة ثم أعد الإرسال، وسيُنشأ رمز جديد تلقائياً",
});

/**
 * يستعيد ردّ طلب العرض الضائع قبل Turnstile، لكن فقط لمالك المفتاح نفسه. لا ينشئ عميلاً
 * ولا يلمس أي سجل؛ اصطدام المفتاح بهاتف آخر يفشل بلا كشف رقم SRQ أو أي تفاصيل تجارية.
 */
export async function findOwnedStorefrontQuoteRequestReplay(
  input: CreateStorefrontQuoteRequestInput,
): Promise<CreateStorefrontQuoteRequestResult | null> {
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId) return null;
  const phone = normalizeStorePhone(input.customerPhone);
  return withTx(async (tx) => {
    const replay = (
      await tx
        .select({
          id: storefrontQuoteRequests.id,
          requestNumber: storefrontQuoteRequests.requestNumber,
          customerId: storefrontQuoteRequests.customerId,
          guestTrackingPublicId: storefrontQuoteRequests.guestTrackingPublicId,
          guestTrackingTokenHash:
            storefrontQuoteRequests.guestTrackingTokenHash,
          guestTrackingExpiresAt:
            storefrontQuoteRequests.guestTrackingExpiresAt,
        })
        .from(storefrontQuoteRequests)
        .where(eq(storefrontQuoteRequests.clientRequestId, clientRequestId))
        .limit(1)
    )[0];
    if (!replay || replay.customerId == null) return null;

    const owner = (
      await tx
        .select({
          phone: customers.phone,
          phone2: customers.phone2,
          phone3: customers.phone3,
          whatsapp: customers.whatsapp,
        })
        .from(customers)
        .where(eq(customers.id, Number(replay.customerId)))
        .limit(1)
    )[0];
    const ownerPhones = owner
      ? [owner.phone, owner.phone2, owner.phone3, owner.whatsapp]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .map(normalizeStorePhone)
      : [];
    if (!owner || !ownerPhones.includes(phone)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: QUOTE_REQUEST_KEY_CONFLICT,
      });
    }
    if (
      input.authenticatedCustomer != null &&
      Number(replay.customerId) !== input.authenticatedCustomer.customerId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر عرض طلب السعر",
          why: "الطلب مسجَّل على حسابٍ غير الحساب الذي سجّلتَ الدخول به",
          doThis:
            "سجّل الدخول بالحساب صاحب الطلب، أو تواصل معنا ومعك رقم الطلب للتحقّق",
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
  });
}

export async function createStorefrontQuoteRequest(
  input: CreateStorefrontQuoteRequestInput,
): Promise<CreateStorefrontQuoteRequestResult> {
  // قد تصل نقرتان بالمعرّف نفسه قبل التزام الأولى؛ القيد الفريد هو الحكم، وإعادة المحاولة
  // تجعل الثانية تقرأ الطلب الفائز بدلاً من تحويل إعادة الإرسال الطبيعية إلى خطأ للمستخدم.
  return retryOnDup(() => createStorefrontQuoteRequestAttempt(input));
}

async function createStorefrontQuoteRequestAttempt(
  input: CreateStorefrontQuoteRequestInput,
): Promise<CreateStorefrontQuoteRequestResult> {
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
          message: QUOTE_REQUEST_KEY_CONFLICT,
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
