import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  customers,
  productPrices,
  products,
  productUnits,
  productVariants,
  storefrontQuoteRequestItems,
  storefrontQuoteRequests,
  quotations,
} from "../../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { getDb, type Tx } from "../../db";
import { withTx } from "../tx";

export type StorefrontQuoteRequestStatus =
  | "PENDING"
  | "CONTACTED"
  | "QUOTED"
  | "CLOSED"
  | "CANCELLED";

const ALLOWED_TRANSITIONS: Record<
  StorefrontQuoteRequestStatus,
  StorefrontQuoteRequestStatus[]
> = {
  PENDING: ["CONTACTED", "CANCELLED"],
  // QUOTED لا يمر من تحديث حالة يدوي: ينشأ فقط داخل معاملة إصدار quotations الرسمي وربطه.
  CONTACTED: ["CLOSED", "CANCELLED"],
  QUOTED: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

export async function listStorefrontQuoteRequests(input: {
  scopedBranchId: number | null;
  status?: StorefrontQuoteRequestStatus | null;
  limit?: number;
}) {
  const db = getDb();
  if (!db) return [];
  const conditions = [
    input.scopedBranchId != null
      ? eq(storefrontQuoteRequests.branchId, input.scopedBranchId)
      : undefined,
    input.status ? eq(storefrontQuoteRequests.status, input.status) : undefined,
  ].filter(Boolean);
  const rows = await db
    .select({
      id: storefrontQuoteRequests.id,
      requestNumber: storefrontQuoteRequests.requestNumber,
      branchId: storefrontQuoteRequests.branchId,
      status: storefrontQuoteRequests.status,
      requestType: storefrontQuoteRequests.requestType,
      companyName: storefrontQuoteRequests.companyName,
      governorate: storefrontQuoteRequests.governorate,
      contactPreference: storefrontQuoteRequests.contactPreference,
      customerNote: storefrontQuoteRequests.customerNote,
      staffNote: storefrontQuoteRequests.staffNote,
      officialQuotationId: storefrontQuoteRequests.officialQuotationId,
      officialQuoteNumber: quotations.quoteNumber,
      createdAt: storefrontQuoteRequests.createdAt,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(storefrontQuoteRequests)
    .leftJoin(customers, eq(customers.id, storefrontQuoteRequests.customerId))
    .leftJoin(quotations, eq(quotations.id, storefrontQuoteRequests.officialQuotationId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(storefrontQuoteRequests.id))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 300));
  const ids = rows.map((row) => Number(row.id));
  const items = ids.length
    ? await db
        .select({
          quoteRequestId: storefrontQuoteRequestItems.quoteRequestId,
          productName: storefrontQuoteRequestItems.productName,
          variantLabel: storefrontQuoteRequestItems.variantLabel,
          unitName: storefrontQuoteRequestItems.unitName,
          quantity: storefrontQuoteRequestItems.quantity,
        })
        .from(storefrontQuoteRequestItems)
        .where(inArray(storefrontQuoteRequestItems.quoteRequestId, ids))
    : [];
  const itemsByRequest = new Map<number, typeof items>();
  for (const item of items) {
    const requestId = Number(item.quoteRequestId);
    itemsByRequest.set(requestId, [...(itemsByRequest.get(requestId) ?? []), item]);
  }
  return rows.map((row) => ({
    id: Number(row.id),
    requestNumber: row.requestNumber,
    branchId: Number(row.branchId),
    status: row.status as StorefrontQuoteRequestStatus,
    requestType: row.requestType,
    companyName: row.companyName ?? null,
    governorate: row.governorate ?? null,
    contactPreference: row.contactPreference,
    customerNote: row.customerNote,
    staffNote: row.staffNote ?? null,
    officialQuotationId: row.officialQuotationId ? Number(row.officialQuotationId) : null,
    officialQuoteNumber: row.officialQuoteNumber ?? null,
    customerName: row.customerName ?? null,
    customerPhone: row.customerPhone ?? null,
    createdAt: row.createdAt,
    items: (itemsByRequest.get(Number(row.id)) ?? []).map((item) => ({
      productName: item.productName,
      variantLabel: item.variantLabel ?? null,
      unitName: item.unitName,
      quantity: Number(item.quantity),
    })),
  }));
}

/**
 * حمولة محرر العرض الرسمي. نستعمل لقطة الطلب لشرح السياق فقط، ونقرأ هوية المنتج/السعر
 * الحالية من الكتالوج حتى لا تتحول لقطة قديمة إلى التزام سعري أو صنف محذوف.
 */
export async function getStorefrontQuoteRequestForOfficialQuotation(input: {
  requestId: number;
  scopedBranchId: number | null;
}) {
  const db = getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "خدمة طلبات عروض الأسعار غير متاحة مؤقتاً",
    });
  }
  const request = (
    await db
      .select({
        id: storefrontQuoteRequests.id,
        requestNumber: storefrontQuoteRequests.requestNumber,
        branchId: storefrontQuoteRequests.branchId,
        status: storefrontQuoteRequests.status,
        requestType: storefrontQuoteRequests.requestType,
        companyName: storefrontQuoteRequests.companyName,
        governorate: storefrontQuoteRequests.governorate,
        contactPreference: storefrontQuoteRequests.contactPreference,
        customerNote: storefrontQuoteRequests.customerNote,
        customerId: storefrontQuoteRequests.customerId,
        customerName: customers.name,
        customerPriceTier: customers.defaultPriceTier,
      })
      .from(storefrontQuoteRequests)
      .leftJoin(customers, eq(customers.id, storefrontQuoteRequests.customerId))
      .where(eq(storefrontQuoteRequests.id, input.requestId))
      .limit(1)
  )[0];
  if (!request) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح طلب عرض السعر",
        why: "رقم الطلب غير موجود أو لم يعد متاحاً",
        doThis: "حدّث قائمة طلبات عروض الأسعار ثم اختر الطلب الصحيح",
      }),
    });
  }
  if (input.scopedBranchId != null && Number(request.branchId) !== input.scopedBranchId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر فتح طلب عرض السعر",
        why: "الطلب يتبع فرعاً آخر خارج نطاق صلاحيتك",
        doThis: "افتحه من الفرع المكلّف به أو اطلب من مدير الفرع المتابعة",
      }),
    });
  }
  if (request.status !== "CONTACTED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لا يمكن تحرير عرض رسمي من هذا الطلب",
        why: request.status === "QUOTED"
          ? "صدر للطلب عرض رسمي بالفعل"
          : "يجب تسجيل تواصل ومراجعة الطلب قبل تحرير العرض الرسمي",
        doThis: "حدّث حالة الطلب من طابور المتجر ثم أعد فتحه",
      }),
    });
  }

  const items = await db
    .select({
      productUnitId: storefrontQuoteRequestItems.productUnitId,
      productName: storefrontQuoteRequestItems.productName,
      variantLabel: storefrontQuoteRequestItems.variantLabel,
      unitName: storefrontQuoteRequestItems.unitName,
      quantity: storefrontQuoteRequestItems.quantity,
      currentVariantId: productUnits.variantId,
      currentUnitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      unitActive: productUnits.isActive,
      variantActive: productVariants.isActive,
      productId: productVariants.productId,
      sku: productVariants.sku,
      currentVariantName: productVariants.variantName,
      productActive: products.isActive,
    })
    .from(storefrontQuoteRequestItems)
    .leftJoin(productUnits, eq(productUnits.id, storefrontQuoteRequestItems.productUnitId))
    .leftJoin(productVariants, eq(productVariants.id, productUnits.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .where(eq(storefrontQuoteRequestItems.quoteRequestId, input.requestId));
  const unitIds = items
    .map((item) => item.productUnitId)
    .filter((id): id is number => id != null)
    .map(Number);
  const prices = unitIds.length
    ? await db
        .select({
          productUnitId: productPrices.productUnitId,
          priceTier: productPrices.priceTier,
          price: productPrices.price,
        })
        .from(productPrices)
        .where(inArray(productPrices.productUnitId, unitIds))
    : [];
  const priceTier = request.customerPriceTier ?? "RETAIL";
  const priceByUnit = new Map<number, string>();
  const retailPriceByUnit = new Map<number, string>();
  for (const price of prices) {
    const unitId = Number(price.productUnitId);
    if (price.priceTier === priceTier) priceByUnit.set(unitId, price.price);
    if (price.priceTier === "RETAIL") retailPriceByUnit.set(unitId, price.price);
  }
  return {
    id: Number(request.id),
    requestNumber: request.requestNumber,
    branchId: Number(request.branchId),
    requestType: request.requestType,
    companyName: request.companyName ?? null,
    governorate: request.governorate ?? null,
    contactPreference: request.contactPreference,
    customerNote: request.customerNote,
    customerId: request.customerId ? Number(request.customerId) : null,
    customerName: request.customerName ?? null,
    customerPriceTier: priceTier,
    items: items.map((item) => {
      const productUnitId = item.productUnitId ? Number(item.productUnitId) : null;
      const isCurrentCatalogLine = Boolean(
        productUnitId && item.currentVariantId && item.productId && item.unitActive && item.variantActive && item.productActive,
      );
      return {
        productUnitId,
        productName: item.productName,
        variantLabel: item.variantLabel ?? null,
        unitName: item.unitName,
        quantity: Number(item.quantity),
        isCurrentCatalogLine,
        productId: isCurrentCatalogLine ? Number(item.productId) : null,
        variantId: isCurrentCatalogLine ? Number(item.currentVariantId) : null,
        sku: isCurrentCatalogLine ? item.sku : null,
        currentVariantName: isCurrentCatalogLine ? item.currentVariantName : null,
        currentUnitName: isCurrentCatalogLine ? item.currentUnitName : null,
        conversionFactor: isCurrentCatalogLine ? item.conversionFactor : null,
        suggestedUnitPrice: productUnitId
          ? priceByUnit.get(productUnitId) ?? retailPriceByUnit.get(productUnitId) ?? null
          : null,
      };
    }),
  };
}

export async function updateStorefrontQuoteRequestStatus(
  input: {
    requestId: number;
    status: StorefrontQuoteRequestStatus;
    staffNote?: string | null;
    scopedBranchId: number | null;
  },
): Promise<{ requestId: number; from: StorefrontQuoteRequestStatus; to: StorefrontQuoteRequestStatus }> {
  return withTx(async (tx: Tx) => {
    const request = (
      await tx
        .select({
          id: storefrontQuoteRequests.id,
          branchId: storefrontQuoteRequests.branchId,
          status: storefrontQuoteRequests.status,
        })
        .from(storefrontQuoteRequests)
        .where(eq(storefrontQuoteRequests.id, input.requestId))
        .for("update")
        .limit(1)
    )[0];
    if (!request) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تحديث طلب عرض السعر",
          why: "رقم طلب العرض غير موجود أو لم يعد متاحاً",
          doThis: "حدّث قائمة طلبات عروض الأسعار ثم اختر الطلب الموجود",
        }),
      });
    }
    if (input.scopedBranchId != null && Number(request.branchId) !== input.scopedBranchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تحديث طلب عرض السعر",
          why: "الطلب يتبع فرعاً آخر خارج نطاق صلاحيتك",
          doThis: "افتح الطلب من الفرع المكلّف به أو اطلب من مدير الفرع المتابعة",
        }),
      });
    }
    const from = request.status as StorefrontQuoteRequestStatus;
    if (from === input.status) return { requestId: input.requestId, from, to: input.status };
    if (!ALLOWED_TRANSITIONS[from].includes(input.status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تحديث حالة طلب عرض السعر",
          why: `الحالة الحالية «${from}» لا تسمح بالانتقال إلى «${input.status}»`,
          doThis: "حدّث الطلب ثم اختر الإجراء التالي المتاح في مسار المتابعة",
        }),
      });
    }
    await tx
      .update(storefrontQuoteRequests)
      .set({
        status: input.status,
        staffNote: input.staffNote?.trim() || null,
      })
      .where(eq(storefrontQuoteRequests.id, input.requestId));
    return { requestId: input.requestId, from, to: input.status };
  });
}
