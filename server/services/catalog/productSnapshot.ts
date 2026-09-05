/**
 * بناءُ مستند لقطة المنتج من مستند التعديل (م٦ ق٨).
 *
 * `getProductForVariantEdit` هو **المصدرُ الوحيد** لمستند التعديل — واللقطةُ صورةٌ منه بعد
 * استبدال بايتات الصور بمراجع (انظر رأس `shared/productSnapshot.ts`). لا حسابَ آخر هنا؛
 * أيّ حقلٍ جديد في مستند التعديل يجب أن يُضاف إلى `ProductSnapshotDocument` صراحةً — وإلّا
 * رفضه TypeScript (المستندُ نوعٌ مُغلَق لا `...spread`).
 */
import { createHash } from "node:crypto";
import {
  PRODUCT_SNAPSHOT_KIND,
  type ProductSnapshotDocument,
  type ProductSnapshotImage,
} from "@shared/productSnapshot";
import type { ProductForVariantEdit } from "./productEditDocument";

/**
 * مرجعُ محتوى صورة: الرابط القصير كما هو؛ وdata URL ⇒ بصمةٌ + طول. البصمةُ sha256 (أوّل ١٦
 * محرفاً) كافيةٌ لكشف الاستبدال في «ما الذي تغيّر» — وليست مفتاحَ تخزين.
 */
export function imageContentRef(url: string | null | undefined): string | null {
  if (url == null) return null;
  const u = String(url);
  if (!u) return null;
  if (!u.startsWith("data:")) return u;
  const digest = createHash("sha256").update(u).digest("hex").slice(0, 16);
  return `data-url:${digest}:${u.length}`;
}

export function buildProductSnapshot(doc: ProductForVariantEdit): ProductSnapshotDocument {
  const images: ProductSnapshotImage[] = doc.images.map((im) => ({
    id: im.id,
    isPrimary: im.isPrimary,
    sortOrder: im.sortOrder,
    ref: imageContentRef(im.url) ?? "",
  }));
  return {
    kind: PRODUCT_SNAPSHOT_KIND,
    id: doc.id,
    name: doc.name,
    productType: doc.productType,
    brand: doc.brand,
    modelName: doc.modelName,
    description: doc.description,
    internalName: doc.internalName,
    storeTitle: doc.storeTitle,
    seoTitle: doc.seoTitle,
    shortTitle: doc.shortTitle,
    posLabel: doc.posLabel,
    invoiceLabel: doc.invoiceLabel,
    marketingCopy: doc.marketingCopy,
    categoryId: doc.categoryId,
    isCustomizable: doc.isCustomizable,
    allowAutoCartRecommendations: doc.allowAutoCartRecommendations,
    isService: doc.isService,
    allowBackorder: doc.allowBackorder,
    isBundle: doc.isBundle,
    isActive: doc.isActive,
    showInReception: doc.showInReception,
    showInPrintPos: doc.showInPrintPos,
    isConsignment: doc.isConsignment,
    consignorId: doc.consignorId,
    consignorName: doc.consignorName,
    unitTemplate: doc.unitTemplate.map((u) => ({
      unitName: u.unitName,
      conversionFactor: u.conversionFactor,
      isBaseUnit: u.isBaseUnit,
      isStoreSaleUnit: u.isStoreSaleUnit,
      retail: u.retail,
      wholesale: u.wholesale,
      government: u.government,
    })),
    variants: doc.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      variantKind: v.variantKind,
      variantName: v.variantName,
      color: v.color,
      colorHex: v.colorHex,
      size: v.size,
      costPrice: v.costPrice,
      baseRetail: v.baseRetail,
      reorderPoint: v.reorderPoint,
      minStock: v.minStock,
      isActive: v.isActive,
      unitBarcodes: { ...v.unitBarcodes },
      imageRef: imageContentRef(v.image),
    })),
    images,
  };
}
