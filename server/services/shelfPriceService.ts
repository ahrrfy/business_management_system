/**
 * shelfPriceService — خدمة استعلام أسعار الرفوف بالباركود (QR Shelf Price Lookup).
 *
 * ⚠️ تحصين أمني مالي صارم (Strict Redaction):
 *  - بيانات يراها الزبون على هاتفه في المتجر (B2C) ⇒ ممنوع نهائياً إرجاع costPrice،
 *    أو أسعار الجملة، أو الكميات الدقيقة للمخزون، أو بيانات الموردين.
 *  - إرجاع فقط الحقول التسويقية:
 *    productId, productUnitId, productName, brand, category, unitName, barcode,
 *    price, originalPrice, discountPercent, promotionName, inStock, imageUrl,
 *    availableUnits, relatedProducts.
 *
 * 🔗 تكامل مع محرك العروض الحية:
 *  - حل العروض الترويجية الحية لفئة RETAIL وتاريخ اليوم بتوقيت بغداد (UTC+3)
 *    عبر resolvePromotionForLine (نقطة العرض = نقطة الفرض).
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  branchStock,
  categories,
  productImages,
  productPrices,
  productUnits,
  productVariants,
  products,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { money, positiveDiff, toDbMoney } from "./money";
import { resolveBarcodeOwnerResult } from "./catalog/barcodeAliases";
import { resolveStorefrontBranchId, storefrontRelated, type StorefrontProduct } from "./storefrontService";
import { resolvePromotionForLine } from "./salesPromotionService";
import { decodeDataUrl, productImageUrl, withPublicProductImageWidth } from "../imageRoute";
import type { PublicProductImageWidth } from "../lib/imageStore";

const RETAIL = "RETAIL" as const;

/** حبيبة اليوم المحلي (بغداد UTC+3) YYYY-MM-DD — لتطابق نافذة العروض الترويجية. */
export function todayYmdBaghdad(): string {
  const baghdad = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return baghdad.toISOString().slice(0, 10);
}

/** تحويل آمن لصورة المنتج مع احترام عهد immutable وروابط السيرفر (ومراعاة showInStore=0 دون 404). */
function toShelfImage(
  image: {
    id: number;
    url: string;
    thumbDataUrl: string | null;
    objectKey: string | null;
    origin: string | null;
  } | null,
  showInStore: boolean,
  preferredWidth: PublicProductImageWidth = 320,
): string | null {
  if (!image) return null;
  const value = image.url?.trim() ?? "";
  if (!showInStore) {
    if (!(image.origin === "ORIGINAL" && image.objectKey != null) && image.thumbDataUrl) {
      return image.thumbDataUrl;
    }
    if (image.thumbDataUrl) return image.thumbDataUrl;
    return value && !/^data:/i.test(value) && !/^\/api\/img\/(?:company\/[^/]+\/)?product\//i.test(value)
      ? value
      : null;
  }
  if (!value) return image.thumbDataUrl ?? null;
  if (!/^data:/i.test(value)) return withPublicProductImageWidth(value, preferredWidth);
  return decodeDataUrl(value) ? productImageUrl(Number(image.id), value, preferredWidth) : (image.thumbDataUrl ?? null);
}

export interface ShelfUnitOption {
  productUnitId: number;
  unitName: string;
  conversionFactor: number;
  price: string | null;
  barcode: string | null;
}

export type ShelfPriceLookupSuccess = {
  found: true;
  productId: number;
  productUnitId: number;
  productName: string;
  brand: string | null;
  category: string | null;
  unitName: string;
  barcode: string | null;
  price: string | null;
  originalPrice: string | null;
  discountPercent: string | null;
  promotionName: string | null;
  inStock: boolean;
  imageUrl: string | null;
  availableUnits: ShelfUnitOption[];
  relatedProducts: StorefrontProduct[];
};

export type ShelfPriceLookupFailure = {
  found: false;
  reason: "NOT_FOUND" | "AMBIGUOUS";
};

export type ShelfPriceLookupResult = ShelfPriceLookupSuccess | ShelfPriceLookupFailure;

/**
 * استعلام سعر الرف بالباركود:
 *  - يحل الباركود (أساسي أو بديل) إلى وحدة المنتج المالكة.
 *  - يجلب الأسعار المفردة الحية، والعروض الترويجية، والصورة المعتمدة، وحالة التوفر.
 *  - يجلب الوحدات الشقيقة لنفس المتغير والمنتجات المكملة للشراء.
 *  - يحجب أي بيانات مالية حساسة (التكلفة، كميات المخزون الدقيقة، أسعار الجملة).
 */
export async function lookupShelfPrice(
  barcode: string,
  branchIdInput?: number,
): Promise<ShelfPriceLookupResult> {
  const db = getDb();
  if (!db) {
    return { found: false, reason: "NOT_FOUND" };
  }

  const code = String(barcode ?? "").trim();
  if (!code) {
    return { found: false, reason: "NOT_FOUND" };
  }

  // ١. تحديد الفرع التشغيلي المعني بالاستعلام بمرونة وأمان ضد الأخطاء
  let branchId: number | null = null;
  if (branchIdInput != null) {
    try {
      branchId = await resolveStorefrontBranchId(branchIdInput);
    } catch {
      // الفرع الممرر غير موجود أو غير نشط — نتراجع لفرع المتجر الافتراضي أو استعلام عام
      try {
        branchId = await resolveStorefrontBranchId();
      } catch {
        branchId = null;
      }
    }
  } else {
    try {
      branchId = await resolveStorefrontBranchId();
    } catch {
      branchId = null;
    }
  }

  // ٢. مطابقة الباركود الأساسي والبدائل مع التطبيع الآمن
  const resolution = await resolveBarcodeOwnerResult(db, code, { allowNormalizedFallback: true });
  if (resolution.status === "NOT_FOUND") {
    return { found: false, reason: "NOT_FOUND" };
  }
  if (resolution.status === "AMBIGUOUS") {
    return { found: false, reason: "AMBIGUOUS" };
  }

  const owner = resolution.owner;

  // ٣. جلب بيانات الصنف من الجداول الأساسية بحقول تسويقية آمنة فقط
  const rows = await db
    .select({
      productId: products.id,
      categoryId: products.categoryId,
      productName: products.name,
      brand: products.brand,
      category: categories.name,
      showInStore: products.showInStore,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
      productUnitId: productUnits.id,
      isBaseUnit: productUnits.isBaseUnit,
      conversionFactor: productUnits.conversionFactor,
      price: productPrices.price,
      barcode: productUnits.barcode,
      stockQuantity: branchStock.quantity,
      isService: products.isService,
      isBundle: products.isBundle,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(
      productPrices,
      and(
        eq(productPrices.productUnitId, productUnits.id),
        eq(productPrices.priceTier, RETAIL),
      ),
    )
    .leftJoin(
      branchStock,
      and(
        eq(branchStock.variantId, productVariants.id),
        branchId != null ? eq(branchStock.branchId, branchId) : sql`1=0`,
      ),
    )
    .where(
      and(
        eq(productUnits.id, owner.productUnitId),
        eq(products.isActive, true),
        eq(productVariants.isActive, true),
        eq(productUnits.isActive, true),
      ),
    )
    .limit(1);

  if (!rows.length) {
    return { found: false, reason: "NOT_FOUND" };
  }

  const row = rows[0];
  const approvedImgs = await db
    .select({
      id: productImages.id,
      variantId: productImages.variantId,
      url: productImages.url,
      thumbDataUrl: productImages.thumbDataUrl,
      objectKey: productImages.objectKey,
      origin: productImages.origin,
    })
    .from(productImages)
    .where(and(eq(productImages.productId, Number(row.productId)), eq(productImages.reviewStatus, "APPROVED")))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), desc(productImages.id));
  const matchedImg =
    approvedImgs.find((im) => im.variantId != null && Number(im.variantId) === Number(row.variantId)) ??
    approvedImgs.find((im) => im.variantId == null) ??
    approvedImgs[0] ??
    null;

  // ٤. حساب التوفر (inStock: نعم/لا) دون كشف أرقام المخزون الدقيقة
  const stockQty = row.stockQuantity != null ? Number(row.stockQuantity) : 0;
  const factor = Number(row.conversionFactor ?? 1);
  const inStock = Boolean(row.isService || stockQty >= factor);

  // ٥. التحقق من العروض الترويجية الحية لفئة المفرد RETAIL
  let effectivePrice = row.price ?? null;
  let originalPrice: string | null = null;
  let discountPercent: string | null = null;
  let promotionName: string | null = null;

  if (effectivePrice && branchId != null) {
    try {
      const todayYmd = todayYmdBaghdad();
      const promo = await resolvePromotionForLine(db as any, {
        branchId,
        customerTier: RETAIL,
        todayYmd,
        productId: owner.productId,
        variantId: owner.variantId,
        productUnitId: Number(row.productUnitId),
        isBaseUnit: Boolean(row.isBaseUnit),
        isBundle: Boolean(row.isBundle),
        categoryId: row.categoryId != null ? Number(row.categoryId) : null,
        unitPrice: effectivePrice,
        lineAmount: effectivePrice,
        hasContractPrice: false,
      });

      if (promo) {
        const original = money(effectivePrice);
        const discount = money(promo.discountForUnit);
        if (discount.gt(0)) {
          originalPrice = effectivePrice;
          const discounted = positiveDiff(original, discount);
          effectivePrice = toDbMoney(discounted);
          const pct = discount.div(original).mul(100).round();
          discountPercent = String(pct.toNumber());
          promotionName = promo.promotionName;
        }
      }
    } catch {
      // إخفاق صامت لحساب الخصم لضمان عرض السعر الأساسي دائماً
    }
  }

  // ٦. جلب الوحدات الشقيقة لنفس المتغير (قطعة / دستة / كرتون) وأسعارها المفردة
  let availableUnits: ShelfUnitOption[] = [];
  try {
    const siblingRows = await db
      .select({
        productUnitId: productUnits.id,
        unitName: productUnits.unitName,
        conversionFactor: productUnits.conversionFactor,
        price: productPrices.price,
        barcode: productUnits.barcode,
      })
      .from(productUnits)
      .leftJoin(
        productPrices,
        and(
          eq(productPrices.productUnitId, productUnits.id),
          eq(productPrices.priceTier, RETAIL),
        ),
      )
      .where(
        and(
          eq(productUnits.variantId, owner.variantId),
          eq(productUnits.isActive, true),
        ),
      )
      .orderBy(asc(productUnits.conversionFactor));

    availableUnits = siblingRows.map((u) => ({
      productUnitId: Number(u.productUnitId),
      unitName: u.unitName,
      conversionFactor: Number(u.conversionFactor ?? 1),
      price: u.price ?? null,
      barcode: u.barcode ?? null,
    }));
  } catch {
    availableUnits = [];
  }

  // ٧. جلب حتى 6 منتجات مقترحة للشراء المكمل
  let relatedProducts: StorefrontProduct[] = [];
  if (branchId != null) {
    try {
      relatedProducts = await storefrontRelated(owner.productId, branchId, 6);
    } catch {
      relatedProducts = [];
    }
  }

  // ٨. النتيجة المحصنة أمنياً: لا تكلفة، لا مخزون تفصيلي، لا موردين، لا أسعار جملة
  return {
    found: true,
    productId: Number(row.productId),
    productUnitId: Number(row.productUnitId),
    productName: row.productName,
    brand: row.brand ?? null,
    category: row.category ?? null,
    unitName: row.unitName,
    barcode: row.barcode ?? owner.primaryBarcode ?? code,
    price: effectivePrice,
    originalPrice,
    discountPercent,
    promotionName,
    inStock,
    imageUrl: toShelfImage(
      matchedImg
        ? {
            id: Number(matchedImg.id),
            url: matchedImg.url,
            thumbDataUrl: matchedImg.thumbDataUrl,
            objectKey: matchedImg.objectKey,
            origin: matchedImg.origin,
          }
        : null,
      row.showInStore !== false,
    ),
    availableUnits,
    relatedProducts,
  };
}
