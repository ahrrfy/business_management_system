/**
 * ═══ مستندُ لقطةِ المنتج (م٦ ق٨ — «اللقطة والاستعادة») ═══
 *
 * **ما هو:** الحمولةُ التي تُكتب في `recordVersions.payloadJson` قبل كلّ تعديلٍ لمنتج، وهي
 * **مستندُ التعديل نفسُه** كما تحمّله شاشةُ المنتج (`catalog.getForVariantEdit`): الترويسة +
 * قالب الوحدات + المتغيّرات بباركوداتها وأسعارها + مراجعُ الصور. الاستعادةُ تُحوّل هذا المستند
 * إلى حمولة `updateProductVariants` فيمرّ بكلّ حرّاس التعديل — لا كتابةٌ خامّ.
 *
 * **لماذا مستندُ الشاشة لا صفُّ الجدول:** صفُّ `products` وحده لا يُعيد المنتج — التكلفة في
 * `productVariants`، والأسعار في `productPrices`، والباركود في `productUnits`. ما يراه
 * الموظّف ويعدّله هو المستندُ المركَّب، فهو ما يجب أن يعود عند الاستعادة.
 *
 * **الصورُ مراجعُ لا بايتات — عمداً:** `productImages.url` عمودُ `MEDIUMTEXT` قد يحمل
 * data URL بحجم ميغابايتات (صفوفٌ إرثيّة). تضمينُها في كلّ لقطة يضاعف حجم الجدول مع كلّ
 * حفظ. والصورُ **خارج نطاق الاستعادة أصلاً**: نشرُها وتبديلُها مسارُ الاستوديو (R2) بحرّاسه
 * الخاصّة (`rejectLegacyCatalogMediaWrite`)، فاللقطة تحفظ **هويّة** الصورة (المعرّف
 * والترتيب والرئيسيّة وبصمةَ محتواها) كي يُظهر «ما الذي تغيّر» تبديلَها، لا لتُعيدها.
 * هذا تعريفٌ صريحٌ لحدود المستند، لا اقتطاعٌ صامت (الاقتطاع الصامت ممنوع — ق٨).
 *
 * ⛔ الملفّ في `shared/` كي يقرأه الخادم (البناء والفرق) والواجهة (العرض) بالنوع نفسه.
 *    لا استيراد من `server/**` هنا.
 */

/** وسمُ الصيغة — يُرفض أيُّ مستندٍ لا يحمله عند الاستعادة (لقطةٌ من كيانٍ آخر أو صيغةٍ أقدم). */
export const PRODUCT_SNAPSHOT_KIND = "product.editDocument.v1" as const;

export type ProductSnapshotUnit = {
  unitName: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  isStoreSaleUnit: boolean;
  retail: string;
  wholesale: string;
  government: string;
};

export type ProductSnapshotVariant = {
  id: number;
  sku: string;
  variantKind: "VARIANT" | "ALTERNATIVE";
  variantName: string | null;
  color: string | null;
  colorHex: string | null;
  size: string | null;
  costPrice: string;
  baseRetail: string;
  reorderPoint: number;
  minStock: number;
  isActive: boolean;
  /** باركود كلّ وحدة بمفتاح اسمها. */
  unitBarcodes: Record<string, string>;
  /**
   * وحداتُ هذا المتغيّر وأسعارُها **كاملةً** (Codex #1008 P1 — لقطةٌ لا تفقد).
   *
   * `unitTemplate` على مستوى المستند قالبٌ مشترَكٌ مُشتقٌّ من **أوّل متغيّر** فقط؛ ومنتجٌ أُنشئ/عُدّل
   * بمسار المعرّف (`catalog.updateProduct`) قد تختلف وحداتُه/أسعارُه بين المتغيّرات. بلا هذا الحقل كانت
   * الاستعادةُ تنقل قالبَ الأوّل إلى الكلّ فتُغيّر كمّياتٍ وأسعاراً **بصمت**. يُحفَظ هنا لكلّ متغيّرٍ على
   * حدة كي تَكشف الاستعادةُ الانحرافَ وتفشلَ مغلقةً بدل أن تُفسِد (§٥: لا تقريب/طمس صامت).
   *
   * لقطاتٌ أقدم من هذا الإصلاح تفتقده (`undefined`) — القارئُ يتعامل معها بوصفها موحّدةً (سلوكٌ سابق).
   */
  units: ProductSnapshotUnit[];
  /** مرجعُ صورة اللون (انظر `ProductSnapshotImage.ref`) أو null. */
  imageRef: string | null;
};

export type ProductSnapshotImage = {
  id: number;
  isPrimary: boolean;
  sortOrder: number;
  /**
   * مرجعُ المحتوى لا المحتوى: رابطٌ قصير كما هو، أو لـdata URL: `data-url:<sha256 أوّل ١٦>:<الطول>`.
   * يكفي لإظهار «تبدّلت الصورة» في الفرق، ولا يُعيد بايتاتٍ عند الاستعادة (الصور خارج نطاقها).
   */
  ref: string;
};

export type ProductSnapshotDocument = {
  kind: typeof PRODUCT_SNAPSHOT_KIND;
  id: number;
  name: string;
  productType: string | null;
  brand: string | null;
  modelName: string | null;
  description: string | null;
  internalName: string | null;
  storeTitle: string | null;
  seoTitle: string | null;
  shortTitle: string | null;
  posLabel: string | null;
  invoiceLabel: string | null;
  marketingCopy: string | null;
  categoryId: number | null;
  isCustomizable: boolean;
  allowAutoCartRecommendations: boolean;
  isService: boolean;
  allowBackorder: boolean;
  isBundle: boolean;
  isActive: boolean;
  showInReception: boolean;
  showInPrintPos: boolean;
  isConsignment: boolean;
  consignorId: number | null;
  consignorName: string | null;
  unitTemplate: ProductSnapshotUnit[];
  variants: ProductSnapshotVariant[];
  images: ProductSnapshotImage[];
};

/**
 * حارسُ الشكل — يُستعمل قبل الاستعادة: لقطةٌ بلا وسمٍ أو بمعرّفٍ مختلف تُرفض قبل أن تصل إلى
 * أيّ كتابة. فحصٌ بنيويّ خفيف (الوسم + الحقول الحاكمة)؛ الحرّاسُ التفصيليّة في مسار التعديل.
 */
export function isProductSnapshotDocument(value: unknown): value is ProductSnapshotDocument {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === PRODUCT_SNAPSHOT_KIND &&
    typeof v.id === "number" &&
    typeof v.name === "string" &&
    Array.isArray(v.unitTemplate) &&
    Array.isArray(v.variants) &&
    Array.isArray(v.images)
  );
}
