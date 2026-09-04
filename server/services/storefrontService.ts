/**
 * storefrontService — كتالوج آمن **علني** (بلا مصادقة) لمتجر الزبون على الجوال (B2C).
 *
 * ⚠️ أمن مالي حاكم (نظير kioskService): بيانات يراها الزبون على الإنترنت ⇒ لا تُعيد أبداً
 * التكلفة ولا **كمية** المخزون ولا أسعار الجملة/الحكومي — فقط الحقول التسويقية الآمنة +
 * **توفّر** (inStock: نعم/لا، لا الكمية) + **سعر العرض** بعد الخصم إن وُجد.
 *
 * 🔗 مزامنة حقيقية مع النظام (لا بيانات منفصلة): يقرأ نفس جداول `products/productPrices/branchStock`
 * ويطبّق **قواعد محرّك العروض نفسها** عبر snapshot مجمّعة — فالسعر المعروض
 * = السعر المفروض (نقطة العرض = نقطة الفرض)، وطلب الزبون يُعاد تسعيره بنفس المحرّك خادمياً.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  bundleComponents,
  categories,
  invoiceItems,
  productImages,
  productCustomizationFields,
  productCustomizationTemplates,
  productPrices,
  productRelatedProducts,
  productUnits,
  productVariants,
  products,
  promotions,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { createTtlCache } from "../lib/ttlCache";
import { getCurrentCompanyId } from "../tenancy/context";
import { escLike } from "../lib/sqlLike";
import {
  ARABIC_NORMALIZATION_PAIRS,
  normalizeArabicSearch,
} from "../../shared/storefrontSearchNormalize";
import { decodeDataUrl, productImageUrl, withPublicProductImageWidth } from "../imageRoute";
import type { PublicProductImageWidth } from "../lib/imageStore";
import { withTx } from "./tx";
import { money, toDbMoney } from "./money";
import { loadPromotionRuleSnapshot, resolvePromotionFromSnapshot } from "./salesPromotionService";
import { resolveColorHex, normalizeHex } from "@shared/colorBank";
import { requireActiveBranch, requireStorefrontContext } from "./storefrontContextService";
import {
  evaluateStorefrontUnitEligibility,
  storefrontPublishableCondition,
} from "./storefrontEligibilityService";
import { resolveBarcodeOwnerResult } from "./catalog/barcodeAliases";
import { loadVariantAvailability } from "./catalog/variantAvailability";
import { titleForChannel } from "@shared/productChannelTitles";
import {
  STOREFRONT_DERIVED_RANKING_LIMITS,
  StorefrontDerivedRankingCache,
  buildStorefrontRankingCacheKey,
} from "./storefrontDerivedCache";

const RETAIL = "RETAIL" as const;

/** حبيبة اليوم المحلي (بغداد UTC+3) YYYY-MM-DD — نظير pos.ts (لتطابق نافذة العروض). */
function todayYmdBaghdad(): string {
  const baghdad = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return baghdad.toISOString().slice(0, 10);
}

/**
 * فرع المتجر يُقرأ من مرجع تشغيلي صريح. المعامل explicit موجود فقط لمسارات إدارية عامة
 * تحتاج فرعاً بعينه، ويُتحقق من وجوده وتفعيله؛ لا fallback إلى MAIN/أول فرع/الرقم 1.
 */
export async function resolveStorefrontBranchId(explicit?: number | null): Promise<number> {
  if (explicit != null) return requireActiveBranch(explicit);
  return (await requireStorefrontContext()).branchId;
}

export interface StorefrontCustomizationField {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: "TEXT" | "TEXTAREA" | "SELECT" | "FILE" | "NUMBER" | "SWATCH";
  isRequired: boolean;
  sortOrder: number;
  maxLength: number | null;
  options: { value: string; label: string; priceDelta: string }[];
  dependency: { fieldKey: string; operator: "equals" | "notEquals"; value: string | string[] } | null;
  priceDelta: string;
}

export interface StorefrontCustomizationTemplate {
  id: number;
  kind: "PRINT" | "GIFT" | "GENERAL";
  title: string;
  description: string | null;
  fields: StorefrontCustomizationField[];
}

/** صفّ عرض آمن للزبون — لا تكلفة ولا كمية مخزون ولا أسعار جملة/حكومي. */
export interface StorefrontProduct {
  productId: number;
  /** مُعرّف وحدة الأساس — يحتاجه سطر الطلب (createOrder). مُعرّف فقط، لا حقل حسّاس. */
  productUnitId: number;
  variantId: number;
  productName: string;
  description?: string | null;
  brand: string | null;
  category: string | null;
  categoryId: number | null;
  unitName: string;
  /** سعر المفرد الأصلي (RETAIL). */
  price: string | null;
  /** سعر العرض بعد الخصم (null = لا عرض ⇒ يُستعمل price). */
  salePrice: string | null;
  /** اسم العرض المطبَّق (للشارة) — null لا عرض. */
  promotionName: string | null;
  /** متوفّر: رصيد الفرع بالأساس يغطي معامل وحدة البيع — نعم/لا فقط، لا نكشف الرصيد الكامل. */
  inStock: boolean;
  imageUrl: string | null;
  /** صور المنتج المعتمدة، مرتبة من الأساسية؛ تُعاد في التفاصيل فقط. */
  imageUrls?: string[];
  /** المنتج معلّم صراحةً من النظام كقابل للتخصيص؛ لا يُستنتج من الاسم أو الفئة. */
  isCustomizable: boolean;
  /** نوع التخصيص الذي حدده الخادم؛ null للمنتجات العادية. */
  customizationKind: "PRINT" | "GIFT" | null;
  /** قالب الحقول المنظم؛ لا يُعاد للمنتجات غير القابلة للتخصيص. */
  customizationTemplate: StorefrontCustomizationTemplate | null;
  /** بكج (مجموعة مُجمّعة) — يُعرَض بشارة «بكج» ومحتوياته في التفاصيل. */
  isBundle: boolean;
  /**
   * صور المكوّنات المنشورة للبكج، بالترتيب الوصفي وبحدّ أربع صور.
   *
   * لا تُنشأ لها ملفات أو صفوف صور جديدة: هي مراجع إلى صور المنتجات المفردة. لا تُملأ إن كانت
   * للبكج صورة خاصة منشورة؛ فتلك الصورة التسويقية هي المرجع البصري المقصود. الواجهة تستطيع
   * رسمها كشبكة 2×2، بينما `imageUrl` يهبط إلى أولها لتبقى الشاشات الأقدم نافعة.
   */
  bundleImageUrls?: string[];
  /** محتويات البكج (اسم + كمية) — تُملأ في صفحة المنتج فقط للبكجات. */
  bundleItems?: { name: string; quantity: number }[];
  /** الندرة: المتبقّي بالمخزون — يُكشَف فقط حين ينخفض (≤ عتبة) كإشارة تسويقية؛ null إن وفير. */
  stockLeft: number | null;
  /** الدليل الاجتماعي: عدد مرّات بيع المنتج فعلياً (من الفواتير). */
  soldCount: number;
  /**
   * ألوان المنتج (اسم + لون حقيقي «#RRGGBB» + توفّر) — سواتش تسويقية للزبون. تُملأ إن وُجد ≥ لون معروف.
   * تشمل الألوان **النافدة** (inStock=false) لعرض نطاق الألوان كاملاً؛ الواجهة تميّزها بصرياً (باهتة + «نافد»)
   * فلا تُضلِّل الزبون. التوفّر = وجود وحدة متجر مسعّرة يغطي رصيدُ الفرع معاملَها لأيّ متغيّر
   * يحمل هذا اللون (تجميعٌ عبر القياسات).
   */
  colors?: { name: string; hex: string; inStock: boolean }[];
  /** وحدات البيع التي أتاحها المدير للمتجر؛ تُستخدم لاختيار «بند/كارتون» في صفحة المنتج. */
  storeUnits?: StorefrontUnitOption[];
  /** متغيّرات المنتج الفعلية. صفحة المتجر تختار واحداً منها قبل إضافة الصنف للسلة. */
  variants?: StorefrontVariantOption[];
  /**
   * للمنتج بدائلُ حقيقية (متغيّرات ALTERNATIVE منشورة) = منتجاتٌ مختلفة (ماركة/منشأ) تُباع تحت اسمٍ
   * واحد، لكلٍّ مخزونه وسعره وباركوده. شارةٌ في شبكة المتجر تدعو الزبون لفتح التفاصيل واختيار الماركة.
   */
  hasAlternatives: boolean;
}

export interface StorefrontUnitOption {
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  price: string | null;
  salePrice: string | null;
  promotionName: string | null;
  inStock: boolean;
  stockLeft: number | null;
}

export interface StorefrontVariantOption {
  variantId: number;
  label: string;
  /** اسم البديل (الماركة/المنشأ) — لتمييز متغيّرات ALTERNATIVE في العرض. */
  variantName: string | null;
  /** VARIANT = لون/قياس لنفس الصنف؛ ALTERNATIVE = منتجٌ مختلف تحت اسمٍ واحد (يُوسَم بشارة). */
  variantKind: "VARIANT" | "ALTERNATIVE";
  color: string | null;
  colorHex: string | null;
  size: string | null;
  inStock: boolean;
  /** معرض هذا البديل: صوره المعتمدة أولاً ثم صور المنتج العامة كاحتياط. */
  imageUrls: string[];
  /** أول صورة في معرض البديل، لاستعمالها في السلة والحركات البصرية. */
  imageUrl: string | null;
  units: StorefrontUnitOption[];
}

async function loadStorefrontCustomizationTemplate(
  db: NonNullable<ReturnType<typeof getDb>>,
  productId: number,
): Promise<StorefrontCustomizationTemplate | null> {
  const template = (await db
    .select({
      id: productCustomizationTemplates.id,
      kind: productCustomizationTemplates.kind,
      title: productCustomizationTemplates.title,
      description: productCustomizationTemplates.description,
    })
    .from(productCustomizationTemplates)
    .where(and(eq(productCustomizationTemplates.productId, productId), eq(productCustomizationTemplates.isActive, true)))
    .limit(1))[0];
  if (!template) return null;

  const fieldRows = await db
    .select({
      id: productCustomizationFields.id,
      fieldKey: productCustomizationFields.fieldKey,
      label: productCustomizationFields.label,
      fieldType: productCustomizationFields.fieldType,
      isRequired: productCustomizationFields.isRequired,
      sortOrder: productCustomizationFields.sortOrder,
      maxLength: productCustomizationFields.maxLength,
      optionsJson: productCustomizationFields.optionsJson,
      dependencyJson: productCustomizationFields.dependencyJson,
      priceDelta: productCustomizationFields.priceDelta,
    })
    .from(productCustomizationFields)
    .where(and(eq(productCustomizationFields.templateId, Number(template.id)), eq(productCustomizationFields.isActive, true)))
    .orderBy(asc(productCustomizationFields.sortOrder), asc(productCustomizationFields.id));

  return {
    id: Number(template.id),
    kind: template.kind,
    title: template.title,
    description: template.description ?? null,
    fields: fieldRows.map((field) => ({
      id: Number(field.id),
      fieldKey: field.fieldKey,
      label: field.label,
      fieldType: field.fieldType,
      isRequired: field.isRequired,
      sortOrder: Number(field.sortOrder ?? 0),
      maxLength: field.maxLength == null ? null : Number(field.maxLength),
      options: Array.isArray(field.optionsJson)
        ? field.optionsJson.map((option) => ({
            value: String(option.value),
            label: String(option.label),
            priceDelta: String(option.priceDelta ?? "0"),
          }))
        : [],
      dependency: field.dependencyJson ?? null,
      priceDelta: String(field.priceDelta ?? "0"),
    })),
  };
}

/** عتبة «كمية محدودة» — الكمية تُكشَف للزبون فقط عندها فأقلّ (ندرة، لا تسريب مخزون كامل). */
const LOW_STOCK_THRESHOLD = 5;

export interface StorefrontCategory {
  id: number;
  name: string;
  /** كل المنتجات المنشورة في القسم، بما فيها النافدة. */
  productCount: number;
  /** المنتجات التي تملك خيار بيع واحداً على الأقل يغطي رصيدُه معاملَ الوحدة. */
  availableCount: number;
}

export type StorefrontAvailability = "IN_STOCK" | "ALL";

/** صفحة كتالوج علني: مؤشر الاستكمال هو معرّف آخر منتج في ترتيب الكتالوج الحتمي. */
export interface StorefrontCatalogPage {
  items: StorefrontProduct[];
  hasMore: boolean;
  nextCursor: number | null;
}

/** SELECT موحّد بالحقول الآمنة + كمية الفرع (داخلياً لحساب inStock فقط، لا تُصدَّر). */
function safeSelect(db: NonNullable<ReturnType<typeof getDb>>) {
  return db
    .select({
      productId: products.id,
      productUnitId: productUnits.id,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      variantKind: productVariants.variantKind,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      size: productVariants.size,
      productName: products.name,
      description: products.description,
      storeTitle: products.storeTitle,
      brand: products.brand,
      category: categories.name,
      categoryId: products.categoryId,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      price: productPrices.price,
      // الصور تُرفق باستعلام مجمّع بعد حسم الصفوف؛ لا نحمل MEDIUMTEXT ولا نضاعف وحدات
      // البيع بانضمام صورة رئيسية لكل بديل داخل الاستعلام الأساسي.
      imageId: sql<number | null>`null`,
      imageUrl: sql<string | null>`null`,
      productType: products.productType,
      isCustomizable: products.isCustomizable,
      isBundle: products.isBundle,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)));
}

/** مرحلة ترشيح ضيقة: لا تحمل URL/data الصور ولا الحقول التسويقية الثقيلة قبل حسم product-level limit. */
function availabilityCandidateSelect(db: NonNullable<ReturnType<typeof getDb>>) {
  return db
    .select({
      productId: products.id,
      variantId: productVariants.id,
      conversionFactor: productUnits.conversionFactor,
      isFeatured: products.isFeatured,
      productName: products.name,
      storeTitle: products.storeTitle,
      // EXISTS يستعمل idx_pimg_product، ويحافظ على ترتيب «له صورة» بلا JOIN يضاعف
      // صفوف الوحدات عند وجود صورة رئيسية مستقلة لكل بديل.
      hasImage: sql<number>`exists (
        select 1 from ${productImages}
        where ${productImages.productId} = ${products.id}
          and ${productImages.reviewStatus} = 'APPROVED'
        limit 1
      )`,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)));
}

/**
 * كاشات سطح المتجر العامّ (فحص الحمل ٣١/٨/٢٦) — أحاديّة الرحلة، والمفتاح يحمل companyId.
 *
 * الجذر: ثلاثة مسارات على السطح **المجهول** تمسح الكتالوج كاملاً في كل نداء —
 *  (١) ترشيح الكتالوج: مسحٌ بلا `LIMIT` على كل صفوف (وحدة × متغيّر) المنشورة ثمّ تحميل توفّرٍ
 *      لها جميعاً، **ويُعاد المسح كاملاً لكل صفحة** من التمرير اللانهائيّ (المؤشّر يُحلّ بالبحث
 *      داخل القائمة المرتّبة في الذاكرة، فالصفحة الثانية تدفع ثمن الأولى كاملاً من جديد).
 *  (٢) الفئات: وصلٌ خماسيّ على الكتالوج كلّه + تحميل توفّرٍ لكل متغيّر، على إجراءٍ بلا مدخلات.
 *  (٣) عدّاد المبيع: مسحُ تاريخ الفواتير كلّه بلا حدٍّ زمنيّ.
 *
 * ⛔ **لماذا لا `LIMIT` في SQL بدلاً من الكاش؟** الحدّ يقع على **المنتجات بعد تجميع متغيّراتها**
 * لا على صفوف SQL (وإلّا ابتلع منتجٌ بعشر وحداتٍ الصفحةَ كلّها — يثبّته اختبارٌ صريح)، وترتيب
 * الصفحة يبدأ بـ`inStock` المشتقّ من `loadVariantAvailability` (محمّلٌ متعدّد الاستعلامات
 * بارتدادٍ للبكجات) ولا يُعبَّر عنه بـSQL. فالمكسب الصحيح هو **إلغاء تكرار المسح** لا اقتطاعه.
 *
 * المقايضة المقبولة: تغييرُ مخزونٍ أو نشرٍ قد يظهر متأخّراً بمقدار TTL على **ترتيب/عدّ** العرض
 * فقط. لا أثر ماليّ: الطلب يُعاد تسعيره وتُتحقَّق كمّياته تحت قفلٍ في مسار الإنشاء.
 */
const STOREFRONT_CANDIDATES_TTL_MS = 30_000;
const STOREFRONT_CATEGORIES_TTL_MS = 60_000;
const STOREFRONT_SOLD_COUNTS_TTL_MS = 5 * 60_000;
// كاشان منفصلان للترشيح: فضاء مفاتيح **التصفّح** مغلقٌ ومحدود (فرع × فئة × مرشّح توفّر)،
// أمّا **البحث** فنصٌّ حرّ يُدخله الجمهور (≤٦٤ محرفاً) ⇒ فضاءٌ غير محدود. خلطُهما في كاشٍ
// واحد يجعل زاحفاً ببضع مئات مصطلحاتٍ يطرد مفاتيحَ التصفّح الساخنة باستمرار، فينهار المكسب
// كلّه إلى المسح الكامل. الفصل يحصر أثر أيّ إغراقٍ بالبحث داخل حصّته وحدها (مراجعة ٣١/٨).
const candidateOrderCache = createTtlCache<string, number[]>({
  ttlMs: STOREFRONT_CANDIDATES_TTL_MS,
  maxEntries: 60,
});
const candidateSearchCache = createTtlCache<string, number[]>({
  ttlMs: STOREFRONT_CANDIDATES_TTL_MS,
  maxEntries: 40,
});
const categoriesCache = createTtlCache<string, StorefrontCategory[]>({
  ttlMs: STOREFRONT_CATEGORIES_TTL_MS,
  maxEntries: 8,
});
const soldCountsCache = createTtlCache<string, Map<number, number>>({
  ttlMs: STOREFRONT_SOLD_COUNTS_TTL_MS,
  maxEntries: 120,
});

/** الاختبارات تتحقّق من الكتالوج بعد كتاباتها مباشرةً — الكاش يعمى عنها. */
const storefrontCacheDisabled = (): boolean => process.env.NODE_ENV === "test";

const companyScope = (): string => String(getCurrentCompanyId() ?? 0);

function chooseCandidateProductIds(
  rows: Array<{
    productId: number;
    conversionFactor: string;
    isFeatured: boolean | null;
    productName: string;
    hasImage: number;
    availableQty: number;
  }>,
  cap: number,
  availabilityFilter: StorefrontAvailability,
): number[] {
  const productsById = new Map<number, {
    id: number;
    inStock: boolean;
    featured: boolean;
    hasImage: boolean;
    name: string;
  }>();
  for (const row of rows) {
    const id = Number(row.productId);
    const inStock = row.availableQty >= Number(row.conversionFactor);
    const current = productsById.get(id);
    if (current) {
      current.inStock ||= inStock;
      current.hasImage ||= Boolean(row.hasImage);
    } else {
      productsById.set(id, {
        id,
        inStock,
        featured: row.isFeatured === true,
        hasImage: Boolean(row.hasImage),
        name: row.productName,
      });
    }
  }
  return Array.from(productsById.values())
    .filter((product) => availabilityFilter === "ALL" || product.inStock)
    .sort((a, b) =>
      Number(b.inStock) - Number(a.inStock)
      || Number(b.featured) - Number(a.featured)
      || Number(b.hasImage) - Number(a.hasImage)
      || a.name.localeCompare(b.name, "ar")
      || a.id - b.id)
    .slice(0, cap)
    .map((product) => product.id);
}

const storefrontRankingCache = new StorefrontDerivedRankingCache(STOREFRONT_DERIVED_RANKING_LIMITS);

/** قياس تشغيلي خفيف يمكن أخذه من health/diagnostics بلا كشف بيانات الكتالوج نفسها. */
export function storefrontDerivedRankingMetrics() {
  return storefrontRankingCache.snapshot();
}

/** اختبار فقط: يمنع تسرّب ترتيب مشتق بين حالات الاختبار التي تغيّر المخزون مباشرةً. */
export function resetStorefrontDerivedRankingCacheForTests(): void {
  storefrontRankingCache.clear();
}

/**
 * يحمل ترتيب ATP الكامل مرة واحدة لكل (فرع + مرشحات) خلال TTL قصير. cursor لا يدخل المفتاح:
 * صفحات 2..N تقطع snapshot نفسها بدلاً من إعادة مسح variant×unit والمخزون في كل طلب.
 */
async function loadRankedStorefrontProductIds(
  db: NonNullable<ReturnType<typeof getDb>>,
  branchId: number,
  conds: SQL<unknown>[],
  input: {
    availability: StorefrontAvailability;
    categoryIds?: readonly number[] | null;
    search?: string | null;
  },
  cacheResult = true,
): Promise<readonly number[]> {
  const load = async () => {
    const candidateRows = await availabilityCandidateSelect(db).where(and(...conds));
    const hydratedCandidates = await attachAvailability(db, branchId, candidateRows);
    return chooseCandidateProductIds(hydratedCandidates, candidateRows.length, input.availability);
  };
  if (!cacheResult || storefrontCacheDisabled()) return load();
  const key = `${companyScope()}:${buildStorefrontRankingCacheKey({ branchId, ...input })}`;
  return storefrontRankingCache.getOrLoad(key, load);
}

async function attachAvailability<TRow extends { variantId: number }>(
  db: NonNullable<ReturnType<typeof getDb>>,
  branchId: number,
  rows: TRow[],
): Promise<Array<TRow & { stockQty: number; reservedQty: number; availableQty: number; hasStockRow: boolean }>> {
  const availability = await loadVariantAvailability(db, branchId, rows.map((row) => Number(row.variantId)));
  return rows.map((row) => {
    const state = availability.get(Number(row.variantId));
    return {
      ...row,
      stockQty: state?.onHandBase ?? 0,
      reservedQty: state?.reservedBase ?? 0,
      availableQty: state?.availableBase ?? 0,
      hasStockRow: state?.hasStockRow ?? false,
    };
  });
}

/**
 * صورة المنتج كما تُرسَل للمتجر — **رابط** لا data URL (١٦/٧، تعميم نمط البنرات).
 *
 * السقف الافتراضي ٦٠ منتجاً × ~٣٥٠ ك.ب صورةً base64 ≈ **٢١ م.ب في ردٍّ واحد**، بلا كاش
 * (الـSW يضع `/api/*` على NetworkOnly) وبلا تحميلٍ كسول. الكتالوج فارغٌ اليوم ⇒ هذه **وقايةٌ
 * قبل النشر** لا إصلاحُ عطل: بعد نشر المنتجات تصير العلّة متجراً بطيئاً يراه الزبائن.
 *
 * العقد الثلاثيّ (نفس `toPublicImage` في bannerService — وانحداره أمسكه اختبار #207):
 *   • data URL صورة صالحة ⇒ رابط النقطة (`/api/img/product/...`).
 *   • قيمة ليست data URL (مسار/رابط مستورَد) ⇒ **تُمرَّر كما هي** — تحويلها لـnull يُخفي صورةً تعمل.
 *   • null أو data URL تالفة/نوعٌ غير مسموح ⇒ null (شحنها base64 يُبطل الغرض كلّه).
 */
function toPublicProductImage(
  imageId: number | null | undefined,
  value: string | null,
  preferredWidth: PublicProductImageWidth = 320,
): string | null {
  if (!value) return null;
  if (!/^data:/i.test(value.trim())) return withPublicProductImageWidth(value, preferredWidth);
  if (imageId == null) return null;
  return decodeDataUrl(value) ? productImageUrl(Number(imageId), value, preferredWidth) : null;
}

function toStorefront(r: {
  productId: number; productUnitId: number; variantId: number; productName: string; description: string | null; storeTitle: string | null; brand: string | null;
  variantName: string | null; color: string | null; colorHex: string | null; size: string | null;
  category: string | null; categoryId: number | null; unitName: string; conversionFactor: string; price: string | null;
  imageId?: number | null; imageUrl: string | null; productType: string | null; isCustomizable: boolean | null; isBundle: boolean | null;
  stockQty: number; reservedQty: number; availableQty: number; hasStockRow: boolean;
}): StorefrontProduct {
  const factor = Math.max(1, Number(r.conversionFactor) || 1);
  const availableUnits = Math.floor(r.availableQty / factor);
  return {
    productId: Number(r.productId),
    productUnitId: Number(r.productUnitId),
    variantId: Number(r.variantId),
    productName: titleForChannel({ name: r.productName, storeTitle: r.storeTitle }, "store"),
    description: r.description ?? null,
    brand: r.brand ?? null,
    category: r.category ?? null,
    categoryId: r.categoryId != null ? Number(r.categoryId) : null,
    unitName: r.unitName,
    price: r.price ?? null,
    salePrice: null,
    promotionName: null,
    inStock: availableUnits > 0,
    imageUrl: toPublicProductImage(r.imageId, r.imageUrl ?? null),
    isCustomizable: r.isCustomizable === true,
    customizationKind: r.isCustomizable === true ? (r.productType === "PRINT_SERVICE" ? "PRINT" : "GIFT") : null,
    customizationTemplate: null,
    isBundle: !!r.isBundle,
    stockLeft: availableUnits > 0 && availableUnits <= LOW_STOCK_THRESHOLD ? availableUnits : null,
    soldCount: 0,
    hasAlternatives: false, // يُضبط بعد التجميع على مستوى المنتج (يعرف كل متغيّراته).
  };
}

/**
 * يربط البكج بصور مكوّناته **بالمرجع فقط**؛ لا يولّد collage ولا ينسخ base64 إلى صفّ البكج.
 *
 * ترتيب الاختيار لكل مكوّن: صورة المتغيّر نفسه (لون/قياس) ثم الصورة الرئيسية على مستوى المنتج.
 * لا تدخل إلا الصور APPROVED، والسقف أربع بلاطات كي يبقى ردّ الكتالوج ثابتاً وخفيفاً. إذا وضع
 * الموظف صورة خاصة للبكج فلا نخلطها بصور المكوّنات ولا نعيد هذه الخاصية أصلاً.
 */
async function attachBundleComponentImages(
  db: NonNullable<ReturnType<typeof getDb>>,
  items: StorefrontProduct[],
): Promise<void> {
  const targets = items.filter((item) => item.isBundle && !item.imageUrl);
  if (!targets.length) return;

  const bundleVariantIds = Array.from(new Set(targets.map((item) => item.variantId)));
  const components = await db
    .select({
      bundleVariantId: bundleComponents.bundleVariantId,
      componentVariantId: bundleComponents.componentVariantId,
      componentProductId: productVariants.productId,
      sortOrder: bundleComponents.sortOrder,
    })
    .from(bundleComponents)
    .innerJoin(productVariants, eq(bundleComponents.componentVariantId, productVariants.id))
    .where(inArray(bundleComponents.bundleVariantId, bundleVariantIds))
    .orderBy(asc(bundleComponents.bundleVariantId), asc(bundleComponents.sortOrder), asc(bundleComponents.id));
  if (!components.length) return;

  const componentVariantIds = Array.from(new Set(components.map((row) => Number(row.componentVariantId))));
  const componentProductIds = Array.from(new Set(components.map((row) => Number(row.componentProductId))));
  // استعلامان مجمّعان بدلاً من N+1 لكل مكوّن/بكج. الصورة الخاصة بالمتغيّر تتقدّم حتى لو لم
  // تكن primary (هي بالضبط صورة اللون)، ثم fallback لصورة المنتج الرئيسية.
  const [variantImages, productPrimaryImages] = await Promise.all([
    db
      .select({ id: productImages.id, variantId: productImages.variantId, url: productImages.url, sortOrder: productImages.sortOrder })
      .from(productImages)
      .where(and(inArray(productImages.variantId, componentVariantIds), eq(productImages.reviewStatus, "APPROVED")))
      .orderBy(asc(productImages.sortOrder), asc(productImages.id)),
    db
      .select({ id: productImages.id, productId: productImages.productId, url: productImages.url, sortOrder: productImages.sortOrder })
      .from(productImages)
      .where(and(
        inArray(productImages.productId, componentProductIds),
        isNull(productImages.variantId),
        eq(productImages.isPrimary, true),
        eq(productImages.reviewStatus, "APPROVED"),
      ))
      .orderBy(asc(productImages.sortOrder), asc(productImages.id)),
  ]);

  const firstVariantImage = new Map<number, { id: number; url: string }>();
  for (const image of variantImages) {
    const variantId = Number(image.variantId);
    if (!firstVariantImage.has(variantId)) firstVariantImage.set(variantId, { id: Number(image.id), url: image.url });
  }
  const firstProductImage = new Map<number, { id: number; url: string }>();
  for (const image of productPrimaryImages) {
    const productId = Number(image.productId);
    if (!firstProductImage.has(productId)) firstProductImage.set(productId, { id: Number(image.id), url: image.url });
  }

  const componentImagesByBundle = new Map<number, string[]>();
  for (const component of components) {
    const bundleVariantId = Number(component.bundleVariantId);
    const urls = componentImagesByBundle.get(bundleVariantId) ?? [];
    if (urls.length >= 4) continue;
    const image = firstVariantImage.get(Number(component.componentVariantId))
      ?? firstProductImage.get(Number(component.componentProductId));
    if (!image) continue;
    const publicUrl = toPublicProductImage(image.id, image.url);
    // قد تشير صورتان إلى نفس كائن R2/المسار؛ لا نعرض البلاطة ذاتها مرتين.
    if (publicUrl && !urls.includes(publicUrl)) urls.push(publicUrl);
    componentImagesByBundle.set(bundleVariantId, urls);
  }

  for (const item of targets) {
    const urls = componentImagesByBundle.get(item.variantId) ?? [];
    if (!urls.length) continue;
    item.bundleImageUrls = urls;
    // توافق أمامي: كل مستهلك لا يعرف الشبكة يعرض على الأقل أول مكوّن بدل مساحة فارغة.
    item.imageUrl = urls[0];
  }
}

/** يرفق صور المعرض المعتمدة ببطاقات الكتالوج باستعلام واحد؛ صورة المتغير تتقدم على العامة. */
async function attachProductGalleryImages(
  db: NonNullable<ReturnType<typeof getDb>>,
  items: StorefrontProduct[],
  limitPerGallery = 8,
  preferredWidth: PublicProductImageWidth = 320,
): Promise<void> {
  if (!items.length) return;
  const productIds = Array.from(new Set(items.map((item) => item.productId)));
  const variantIds = Array.from(new Set(items.map((item) => item.variantId)));
  // المرحلة الأولى تقرأ metadata خفيفة فقط وتستبعد بدائل غير مطلوبة؛ URL قد يكون MEDIUMTEXT.
  const metadataRows = await db
    .select({
      id: productImages.id,
      productId: productImages.productId,
      variantId: productImages.variantId,
    })
    .from(productImages)
    .where(and(
      inArray(productImages.productId, productIds),
      eq(productImages.reviewStatus, "APPROVED"),
      or(isNull(productImages.variantId), inArray(productImages.variantId, variantIds)),
    ))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), asc(productImages.id));

  const selectedIds = new Set<number>();
  const counts = new Map<string, number>();
  for (const row of metadataRows) {
    const key = row.variantId == null ? `p:${row.productId}` : `v:${row.variantId}`;
    const count = counts.get(key) ?? 0;
    if (count >= limitPerGallery) continue;
    counts.set(key, count + 1);
    selectedIds.add(Number(row.id));
  }
  if (!selectedIds.size) return;
  // المرحلة الثانية وحدها تحمل MEDIUMTEXT، وبسقف حتمي لكل معرض مطلوب.
  const urlRows = await db
    .select({ id: productImages.id, url: productImages.url })
    .from(productImages)
    .where(inArray(productImages.id, Array.from(selectedIds)));
  const urlById = new Map(urlRows.map((row) => [Number(row.id), row.url]));

  const byVariant = new Map<number, string[]>();
  const byProduct = new Map<number, string[]>();
  const add = (target: Map<number, string[]>, key: number, value: string) => {
    const urls = target.get(key) ?? [];
    if (urls.length < limitPerGallery && !urls.includes(value)) urls.push(value);
    target.set(key, urls);
  };
  for (const row of metadataRows) {
    if (!selectedIds.has(Number(row.id))) continue;
    const publicUrl = toPublicProductImage(row.id, urlById.get(Number(row.id)) ?? null, preferredWidth);
    if (!publicUrl) continue;
    if (row.variantId != null) add(byVariant, Number(row.variantId), publicUrl);
    else add(byProduct, Number(row.productId), publicUrl);
  }
  for (const item of items) {
    const urls = [...(byVariant.get(item.variantId) ?? []), ...(byProduct.get(item.productId) ?? [])]
      .filter((url, index, all) => all.indexOf(url) === index)
      .slice(0, limitPerGallery);
    if (urls.length > 0) {
      item.imageUrls = urls;
      item.imageUrl = urls[0];
    }
  }
}

/** يرفق وسائط بطاقات القوائم بالترتيب الحاكم: معرض المنتج أولاً ثم fallback مكوّنات البكج. */
async function attachStorefrontListMedia(
  db: NonNullable<ReturnType<typeof getDb>>,
  items: StorefrontProduct[],
): Promise<void> {
  await attachProductGalleryImages(db, items);
  await attachBundleComponentImages(db, items);
}

/** الدليل الاجتماعي: يُرفق عدد مرّات بيع كل منتج (COUNT فواتير مميّزة) — استعلام مجمَّع واحد. */
async function attachSoldCounts(
  db: NonNullable<ReturnType<typeof getDb>>,
  items: StorefrontProduct[]
): Promise<void> {
  if (!items.length) return;
  const productIds = items.map((i) => i.productId);
  const loadCounts = async (): Promise<Map<number, number>> => {
    const rows = await db
      .select({ productId: productVariants.productId, n: sql<number>`COUNT(DISTINCT ${invoiceItems.invoiceId})` })
      .from(invoiceItems)
      .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .where(inArray(productVariants.productId, productIds))
      .groupBy(productVariants.productId);
    return new Map(rows.map((r) => [Number(r.productId), Number(r.n)]));
  };
  // دليلٌ اجتماعيّ بطيء التغيّر يمسح تاريخ الفواتير كلّه بلا حدٍّ زمنيّ — كاشٌ بخمس دقائق
  // (فحص الحمل ٣١/٨/٢٦). ⚠️ **لا يُقيَّد بنافذةٍ زمنية عمداً**: ذلك يغيّر الأرقام المعروضة
  // («بيع ١٢ مرة» / شارة «الأكثر طلباً») وهو قرارُ منتجٍ لا تحسينُ أداء، ولا اختبارَ يثبّت
  // دلالته اليوم. المفتاح مجموعةُ المنتجات مرتّبةً ⇒ الصفحة الأولى (الأشيع) مفتاحٌ واحد.
  const map = storefrontCacheDisabled()
    ? await loadCounts()
    : await soldCountsCache.get(
        `${companyScope()}:${[...productIds].sort((a, b) => a - b).join(",")}`,
        loadCounts,
      );
  for (const it of items) it.soldCount = map.get(it.productId) ?? 0;
}

/**
 * يُرفق ألوان المنتج المتاحة (اسم + لون حقيقي «#RRGGBB») لكل بطاقة — استعلام مجمَّع واحد للدفعة.
 * اللون الحقيقي = colorHex الصريح إن وُجد، وإلّا يُستنتَج من الاسم عبر بنك الألوان؛ الاسم غير
 * المعروف بلا لون صريح يُتجاهَل (لا نخترع لوناً). فريدٌ بالاسم لكل منتج بسقف ١٢ لوناً.
 */
async function attachVariantColors(
  db: NonNullable<ReturnType<typeof getDb>>,
  items: StorefrontProduct[],
  branchId: number
): Promise<void> {
  if (!items.length) return;
  const productIds = items.map((i) => i.productId);
  // نضمّ وحدات بيع المتجر وأسعارها ورصيد الفرع؛ stock>0 وحده لا يكفي إذا كانت الوحدة كرتوناً بمعامل 12.
  const rows = await db
    .select({
      productId: productVariants.productId,
      variantId: productVariants.id,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      conversionFactor: productUnits.conversionFactor,
      retailPrice: productPrices.price,
    })
    .from(productVariants)
    .leftJoin(productUnits, and(
      eq(productUnits.variantId, productVariants.id),
      eq(productUnits.isActive, true),
      eq(productUnits.isStoreSaleUnit, true),
    ))
    .leftJoin(productPrices, and(
      eq(productPrices.productUnitId, productUnits.id),
      eq(productPrices.priceTier, RETAIL),
    ))
    .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)))
    .orderBy(asc(productVariants.id));
  const availability = await loadVariantAvailability(db, branchId, rows.map((row) => Number(row.variantId)));
  // لكل منتج: خريطة hex → {name, inStock}. التفرّد باللون الفعليّ لا بالاسم (يمنع تكرار سواتش
  // متطابقة: احمر + أحمر فاقع، ويُبقي لونين مختلفين لنفس الاسم). التوفّر **يُجمَّع** عبر كل متغيّرات
  // اللون (لونٌ بعدّة قياسات = متوفّرٌ إن توفّر أيّ قياس منه). أوّل اسم يفوز، والترتيب ثابت بترتيب الظهور.
  const byProduct = new Map<number, Map<string, { name: string; inStock: boolean }>>();
  for (const r of rows) {
    const pid = Number(r.productId);
    const name = (r.color ?? "").trim();
    if (!name) continue;
    const hex = normalizeHex(r.colorHex) ?? resolveColorHex(name);
    if (!hex) continue; // اسم غير معروف بلا لون صريح ⇒ لا سواتش (لا اختراع)
    let m = byProduct.get(pid);
    if (!m) { m = new Map(); byProduct.set(pid, m); }
    const state = availability.get(Number(r.variantId));
    const inStock = evaluateStorefrontUnitEligibility({
      isActive: true,
      isStoreSaleUnit: true,
      retailPrice: r.retailPrice ?? null,
      conversionFactor: r.conversionFactor == null ? null : String(r.conversionFactor),
      stockBase: state?.hasStockRow ? state.onHandBase : null,
      availableBase: state?.availableBase ?? 0,
    }).available;
    const cur = m.get(hex);
    if (cur) cur.inStock ||= inStock; // تجميع التوفّر عبر متغيّرات نفس اللون
    else if (m.size < 12) m.set(hex, { name, inStock });
  }
  for (const it of items) {
    const m = byProduct.get(it.productId);
    if (!m || m.size === 0) continue;
    it.colors = Array.from(m, ([hex, v]) => ({ name: v.name, hex, inStock: v.inStock }));
  }
}

/**
 * يطبّق العروض على قائمة منتجات بقواعد محرّك POS نفسها. تُحمَّل القواعد والأهداف مرة واحدة
 * للصفحة، ثم يكون الحلّ لكل بطاقة نقياً في الذاكرة؛ لا استعلامات تتناسب مع عدد المنتجات.
 *
 * **بلا بوّابة الكتابة الماليّة** (فحص الحمل ٣١/٨/٢٦ — مراجعة عدائية): قراءةٌ محضة (لقطة
 * قواعد + حلٌّ في الذاكرة، صفر كتابة) وكانت تأخذ `FINANCIAL_WRITER` في **كل** صفحة كتالوج
 * ومنتج ومقترحاتٍ من كلّ زائرٍ مجهول — أي أضعافَ حركة التسعيرة التي عولجت أوّلاً. المعاملة
 * تبقى للقطةٍ متّسقة عبر استعلامات اللقطة، لا للذرّية.
 */
async function applyStorefrontPromotions(list: StorefrontProduct[], branchId: number): Promise<void> {
  const eligible = list.filter((p) => p.price != null);
  if (!eligible.length) return;
  const todayYmd = todayYmdBaghdad();
  await withTx(async (tx) => {
    const snapshot = await loadPromotionRuleSnapshot(tx, {
      branchId,
      customerTier: RETAIL,
      todayYmd,
      includeStoreManaged: true,
    });
    for (const p of eligible) {
      const price = money(p.price!);
      const res = resolvePromotionFromSnapshot(snapshot, {
        branchId,
        customerTier: RETAIL,
        productId: p.productId,
        variantId: p.variantId,
        categoryId: p.categoryId ?? null,
        unitPrice: price.toFixed(2),
        lineAmount: price.toFixed(2),
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true, // 0073: المتجر يُدرِج عروضه المتجرية (أونلاين) بخلاف الكاشير
      });
      if (res) {
        const eff = price.minus(money(res.discountForUnit));
        // بطاقة المتجر ليست قناة للهدايا المجانية: لا ننشر سعراً مخفّضاً إلا إذا كان
        // موجباً وأقل فعلاً من سعر التجزئة. يمنع هذا عرض 100% بسبب قواعد خصم مهيأة
        // خطأ أو خصم يتجاوز سعر الوحدة، فيما تبقى قواعد POS محكومة عند إنشاء الطلب.
        if (eff.gt(0) && eff.lt(price)) {
          p.salePrice = toDbMoney(eff);
          p.promotionName = res.promotionName;
        }
      }
    }
  }, { gate: "NONE" });
}

/** كتالوج المتجر: منتجات قابلة للاقتناء (بطاقة لكل منتج) + توفّر + سعر عرض. المتوفّر أولاً. */
export async function storefrontCatalog(opts: {
  branchId?: number;
  categoryId?: number | null;
  search?: string | null;
  limit?: number;
  /** آخر productId رآه الزائر في نفس المرشحات؛ null/undefined = الصفحة الأولى. */
  cursor?: number | null;
  availability?: StorefrontAvailability;
}): Promise<StorefrontCatalogPage> {
  const db = getDb();
  if (!db) return { items: [], hasMore: false, nextCursor: null };
  const branchId = await resolveStorefrontBranchId(opts.branchId);
  const cap = Math.min(Math.max(opts.limit ?? 60, 1), 120);
  const availabilityFilter = opts.availability ?? "IN_STOCK";
  // IN_STOCK هو السلوك الافتراضي المتوافق. ALL يعيد كل المنشور ويترك inStock=false للنافد.
  const conds: SQL<unknown>[] = [storefrontPublishableCondition()];
  if (opts.categoryId != null) conds.push(eq(products.categoryId, opts.categoryId));
  const s = String(opts.search ?? "").trim();
  if (s) {
    // هوية الباركود تُحسم أولاً بالمساواة المفهرسة على الشكل الخام ومرشّحات UPC/EAN؛
    // لا نمرّرها عبر مطبّع بحث الأسماء الذي يطوي مسافتين داخليتين إلى واحدة.
    // مسار الإرث المطبّع يستخدم مفتاح barcodeNormalized المفهرس؛ فلا يضيف مسحاً كاملاً لبحث الأسماء.
    const barcodeResolution = await resolveBarcodeOwnerResult(db, s, { allowNormalizedFallback: true });
    if (barcodeResolution.status === "FOUND") {
      conds.push(eq(products.id, barcodeResolution.owner.productId));
    } else if (barcodeResolution.status === "AMBIGUOUS") {
      conds.push(sql`false`);
    } else {
      // تطبيعٌ عربيّ مشتركٌ مع اقتراحات العميل ([`shared/storefrontSearchNormalize.ts`](../../shared/storefrontSearchNormalize.ts))
      // — يوحّد الألفات (أ/إ/آ ⇒ ا) والتاء المربوطة (ة ⇒ ه) ويطوي الفراغات المتعدّدة. كان الاقتراح
      // يظهر لحظياً لأنّ العميل يُطبّع محلياً، ثمّ يختفي حين يستبدل الخادم صفحات الكتالوج بنتائج LIKE
      // خامّ ⇒ Codex P2 على #904. نطبّق نفس التطبيع على العمود ⇒ ما ظهر في القائمة يبقى في الصفحة.
      //
      // تصحيح Codex على #907 (٢ من ٢): (١) طيّ الفراغات SQL يجب أن يوازي طيّ الفراغات JS وإلّا
      // `قلم  ازرق` المخزَّن لا يُطابق `قلم ازرق` المُبحَث — نطبّقه بـREGEXP_REPLACE. (٢) الباركود
      // يبقى بنمطٍ خامّ (بلا تطبيع عربيّ) — الكتالوجُ يقبله سلسلةً حرّة، فباركودٌ فيه `أ` يُخفَق
      // مع نمطٍ فيه `ا`؛ نُفصلُ نمطَه.
      //
      // الأزواج ثابتةٌ لا مدخلَ من المستخدم ⇒ لا حقن؛ القيمة المُطبَّعة مربوطةٌ بالوسائط.
      // تدقيق ٣/٨: تهريب `%`/`_` (escLike + ESCAPE '!') كبقية مسارات البحث.
      const normalizedTerm = normalizeArabicSearch(s);
      const p = `%${escLike(normalizedTerm)}%`;
      const barcodePattern = `%${escLike(s)}%`;
      // بناءُ عبارة تطبيعٍ على العمود بنفس ترتيب `normalizeArabicSearch`:
      //   REPLACE المُتَتَابع للأزواج → `REGEXP_REPLACE` لطيّ الفراغات → `TRIM` → `LOWER`
      // MySQL 8 REGEXP_REPLACE + POSIX class `[[:space:]]` أوسع من `\\s` (يشمل U+00A0/NBSP وسواه).
      // توسيعُ أزواج التطبيع مستقبلاً يمرّ من ملفٍ واحد ويسري تلقائياً هنا.
      const arabicLike = (col: SQL | AnyColumn, pattern: string) => {
        let expr: SQL = sql`${col}`;
        for (const [from, to] of ARABIC_NORMALIZATION_PAIRS) {
          expr = sql`REPLACE(${expr}, ${from}, ${to})`;
        }
        return sql`LOWER(TRIM(REGEXP_REPLACE(${expr}, '[[:space:]]+', ' '))) LIKE ${pattern} ESCAPE '!'`;
      };
      // storeTitle: عنوان القناة (عرضٌ في المتجر) — كان مغيَّباً عن البحث فتنعدمُ قابليّةُ اكتشاف
      // منتجٍ ذي عنوانٍ متجريٍّ مختلفٍ عن اسمه الداخليّ. `LIKE` على NULL = NULL ⇒ يُعامَل كاذباً في OR.
      const searchCond = or(
        arabicLike(products.name, p),
        arabicLike(products.storeTitle, p),
        arabicLike(products.brand, p),
        sql`${productUnits.barcode} LIKE ${barcodePattern} ESCAPE '!'`,
      );
      if (searchCond) conds.push(searchCond);
    }
  }
  // نرتّب على مستوى المنتج أولاً (بعد حساب ATP)، ثم نأخذ الصفحة. لا نطبّق limit على صفوف
  // variant×unit كي لا يبتلع متغيّر واحد الصفحة كلها. cursor هو آخر منتج من هذا الترتيب لا
  // إزاحة رقمية؛ لذلك لا يكرر بطاقات الصفحة السابقة عند التحميل التدريجي.
  //
  // القائمة المرتّبة مُكيَّشة (فحص الحمل ٣١/٨/٢٦): هي ثمرةُ المسح الكامل + تحميل التوفّر، ولا
  // تتعلّق بـ`limit`/`cursor` إطلاقاً — فكلّ صفحةٍ تالية كانت تُعيد دفع ثمن الأولى كاملاً،
  // وزوّارٌ متزامنون على نفس المرشّحات يدفعونه كلٌّ على حدة. المفتاح يحمل **كلّ** ما يغيّر
  // النتيجة (الشركة/الفرع/الفئة/البحث/مرشّح التوفّر) ولا شيء سواه.
  const loadOrderedIds = (): Promise<readonly number[]> => loadRankedStorefrontProductIds(
    db,
    branchId,
    conds,
    {
      availability: availabilityFilter,
      categoryIds: opts.categoryId == null ? null : [opts.categoryId],
      search: s,
    },
    false,
  );
  // النصّ يُطبَّع بحالة الأحرف كي لا تصير «Pen»/«pen»/«PEN» ثلاثةَ مداخل لنتيجةٍ واحدة
  // (مطابقة MySQL غير حسّاسة للحالة أصلاً).
  const searchKey = s.toLowerCase();
  const orderedIds = storefrontCacheDisabled()
    ? await loadOrderedIds()
    : await (searchKey ? candidateSearchCache : candidateOrderCache).get(
      `${companyScope()}:${branchId}:${opts.categoryId ?? ""}:${availabilityFilter}:${searchKey}`,
        async () => Array.from(await loadOrderedIds()),
      );
  const cursor = opts.cursor ?? null;
  const cursorIndex = cursor == null ? -1 : orderedIds.indexOf(cursor);
  // مؤشر قديم بعد إخفاء المنتج/نفاده لا يعود إلى أول القائمة فيكرر ما رآه الزائر؛ ينتهي بأمان
  // ويستعيد العميل الصفحة الأولى عند تحديث مرشحاته.
  const remainingIds = cursor == null
    ? orderedIds
    : cursorIndex >= 0
      ? orderedIds.slice(cursorIndex + 1)
      : [];
  const hasMore = remainingIds.length > cap;
  const selectedIds = remainingIds.slice(0, cap);
  if (!selectedIds.length) return { items: [], hasMore: false, nextCursor: null };
  const selectedOrder = new Map(selectedIds.map((id, index) => [id, index]));
  const rawRows = await safeSelect(db).where(and(...conds, inArray(products.id, selectedIds)));
  const rows = (await attachAvailability(db, branchId, rawRows))
    .filter((row) => availabilityFilter === "ALL" || row.availableQty >= Number(row.conversionFactor))
    .sort((a, b) =>
      (selectedOrder.get(Number(a.productId)) ?? cap) - (selectedOrder.get(Number(b.productId)) ?? cap)
      || Number(b.availableQty >= Number(b.conversionFactor)) - Number(a.availableQty >= Number(a.conversionFactor))
      || Number(a.conversionFactor) - Number(b.conversionFactor)
      || Number(a.variantId) - Number(b.variantId)
      || Number(a.productUnitId) - Number(b.productUnitId));

  // منتجاتٌ لها بديلٌ حقيقيّ منشور (متغيّر ALTERNATIVE) — لوسم بطاقة الشبكة بـ«ماركات متعددة».
  const productsWithAlternatives = new Set<number>();
  for (const r of rows) {
    if (r.variantKind === "ALTERNATIVE") productsWithAlternatives.add(Number(r.productId));
  }
  const seen = new Set<number>();
  const items: StorefrontProduct[] = [];
  for (const r of rows) {
    const pid = Number(r.productId);
    if (seen.has(pid)) continue;
    seen.add(pid);
    const card = toStorefront(r);
    card.hasAlternatives = productsWithAlternatives.has(pid);
    items.push(card);
    if (items.length >= cap) break;
  }
  await applyStorefrontPromotions(items, branchId);
  await attachSoldCounts(db, items);
  await attachVariantColors(db, items, branchId);
  await attachStorefrontListMedia(db, items);
  // المؤشّر يتقدّم بآخر **معرّفٍ مختار** لا بآخر بطاقةٍ مرسومة (مراجعة عدائية ٣١/٨): كل صنفٍ
  // نفد بين اختيار القائمة وجلب صفوفها يسقط بالتصفية الحيّة أعلاه — وهو **صحيح** (نعرض الحقيقة
  // لا لقطةً قديمة)، لكن لو سقطت الصفحة كلّها كان `last` يصير `undefined` فيعود المؤشّر `null`
  // ويتوقّف التمرير اللانهائيّ نهائياً وآلافُ المنتجات دونه. بالمعرّف المختار يواصل الزائر
  // تصفّحه وتظهر صفحةٌ أقصر فحسب. (العلّة قائمةٌ قبل الكاش بنافذةٍ أضيق — والإصلاح يغطّيهما.)
  const lastSelectedId = selectedIds[selectedIds.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore ? (lastSelectedId ?? null) : null,
  };
}

/** فئات المتجر: لا تختفي لمجرد نفاد المخزون؛ تُعيد المنشور والمتاح كلّاً على حدة. */
export async function storefrontCategories(branchIdInput?: number): Promise<StorefrontCategory[]> {
  const db = getDb();
  if (!db) return [];
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  // إجراءٌ عامٌّ **بلا مدخلات** يمشي على الكتالوج كلّه (وصلٌ خماسيّ) ويحمّل توفّر كل متغيّر —
  // ولا يستعمل من ذلك التوفّر إلا مقارنةً منطقيةً واحدة. نتيجته صغيرة وثابتة نسبياً ⇒ كاشٌ
  // بدقيقة يخدم كلّ الزوّار المتزامنين بمسحٍ واحد (فحص الحمل ٣١/٨/٢٦).
  if (storefrontCacheDisabled()) return computeStorefrontCategories(db, branchId);
  return categoriesCache.get(`${companyScope()}:${branchId}`, () =>
    computeStorefrontCategories(db, branchId),
  );
}

async function computeStorefrontCategories(
  db: NonNullable<ReturnType<typeof getDb>>,
  branchId: number,
): Promise<StorefrontCategory[]> {
  const rawRows = await db
    .select({
      id: categories.id,
      name: categories.name,
      sortOrder: categories.sortOrder,
      productId: products.id,
      variantId: productVariants.id,
      conversionFactor: productUnits.conversionFactor,
    })
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .innerJoin(
      productUnits,
      and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isActive, true), eq(productUnits.isStoreSaleUnit, true))
    )
    .innerJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    // showInStore: يحترم إخفاء المدير للقسم من واجهة المتجر (لوحة hPanel)؛ والترتيب بـsortOrder.
    .where(and(
      storefrontPublishableCondition(),
      eq(categories.isActive, true),
      eq(categories.showInStore, true),
    ))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  const availability = await loadVariantAvailability(db, branchId, rawRows.map((row) => Number(row.variantId)));
  const grouped = new Map<number, {
    id: number;
    name: string;
    sortOrder: number;
    products: Set<number>;
    availableProducts: Set<number>;
  }>();
  for (const row of rawRows) {
    const categoryId = Number(row.id);
    let category = grouped.get(categoryId);
    if (!category) {
      category = {
        id: categoryId,
        name: row.name,
        sortOrder: Number(row.sortOrder ?? 0),
        products: new Set(),
        availableProducts: new Set(),
      };
      grouped.set(categoryId, category);
    }
    const productId = Number(row.productId);
    category.products.add(productId);
    const state = availability.get(Number(row.variantId));
    if ((state?.availableBase ?? 0) >= Number(row.conversionFactor)) {
      category.availableProducts.add(productId);
    }
  }
  return Array.from(grouped.values())
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar") || a.id - b.id)
    .map((category) => ({
      id: category.id,
      name: category.name,
      productCount: category.products.size,
      availableCount: category.availableProducts.size,
    }));
}

/** صفحة منتج واحد (تفاصيل آمنة + توفّر + سعر عرض). */
export async function storefrontProduct(productId: number, branchIdInput?: number): Promise<StorefrontProduct | null> {
  const db = getDb();
  if (!db) return null;
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  const rawRows = await safeSelect(db)
    .where(and(storefrontPublishableCondition(), eq(products.id, productId)))
    .orderBy(asc(productUnits.conversionFactor));
  const rows = (await attachAvailability(db, branchId, rawRows))
    .sort((a, b) =>
      Number(b.availableQty >= Number(b.conversionFactor)) - Number(a.availableQty >= Number(a.conversionFactor))
      || Number(a.conversionFactor) - Number(b.conversionFactor)
      || Number(a.variantId) - Number(b.variantId)
      || Number(a.productUnitId) - Number(b.productUnitId));
  if (!rows.length) return null;
  const options = rows.map(toStorefront);
  await applyStorefrontPromotions(options, branchId);
  // استعلام مجمّع واحد لكل صور المنتج؛ كل option يأخذ معرض بديله ثم الصور العامة.
  // هذا يربط الصور بالـSKU الصحيح بلا N+1 وبلا JOIN يضاعف وحدات البيع.
  await attachProductGalleryImages(db, options, 12, 1200);
  // المتجر يعرض منتجاً واحداً، لكن الطلب يجب أن يحمل المتغيّر المحدد فعلياً
  // (لون/قياس) لا أول SKU صامتاً. كل متغيّر يحتفظ بوحدات بيعه الخاصة.
  const byVariant = new Map<number, StorefrontVariantOption>();
  for (const option of options) {
    const source = rows.find((row) => Number(row.productUnitId) === option.productUnitId)!;
    const variantId = option.variantId;
    let variant = byVariant.get(variantId);
    if (!variant) {
      const parts = [source.variantName, source.color, source.size].map((v) => v?.trim()).filter(Boolean) as string[];
      variant = {
        variantId,
        label: Array.from(new Set(parts)).join(" — ") || "الخيار الافتراضي",
        variantName: source.variantName?.trim() || null,
        variantKind: source.variantKind === "ALTERNATIVE" ? "ALTERNATIVE" : "VARIANT",
        color: source.color?.trim() || null,
        colorHex: normalizeHex(source.colorHex) ?? resolveColorHex(source.color ?? "") ?? null,
        size: source.size?.trim() || null,
        inStock: false,
        imageUrls: option.imageUrls ?? [],
        imageUrl: option.imageUrl,
        units: [],
      };
      byVariant.set(variantId, variant);
    }
    variant.inStock ||= option.inStock;
    variant.units.push({
      productUnitId: option.productUnitId,
      unitName: option.unitName,
      conversionFactor: String(source.conversionFactor),
      price: option.price,
      salePrice: option.salePrice,
      promotionName: option.promotionName,
      inStock: option.inStock,
      stockLeft: option.stockLeft,
    });
  }
  const item = options.find((option) => option.inStock) ?? options[0];
  const primaryVariant = byVariant.get(item.variantId)!;
  item.storeUnits = primaryVariant.units;
  item.variants = Array.from(byVariant.values());
  item.hasAlternatives = item.variants.some((v) => v.variantKind === "ALTERNATIVE");
  if (item.isCustomizable) {
    item.customizationTemplate = await loadStorefrontCustomizationTemplate(db, item.productId);
  }
  await attachSoldCounts(db, [item]);
  await attachVariantColors(db, [item], branchId);
  if (item.isBundle) item.bundleItems = await getBundleItems(db, item.variantId);
  await attachBundleComponentImages(db, [item]);
  return item;
}

/** محتويات البكج (اسم المنتج المكوّن + الكمية) — لعرض «يحتوي على» في صفحة البكج. */
async function getBundleItems(
  db: NonNullable<ReturnType<typeof getDb>>,
  bundleVariantId: number
): Promise<{ name: string; quantity: number }[]> {
  const rows = await db
    .select({ name: products.name, qty: bundleComponents.componentBaseQuantity })
    .from(bundleComponents)
    .innerJoin(productVariants, eq(bundleComponents.componentVariantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(bundleComponents.bundleVariantId, bundleVariantId))
    .orderBy(asc(bundleComponents.sortOrder))
    .limit(30);
  return rows.map((r) => ({ name: r.name, quantity: Number(r.qty) }));
}

/**
 * توصيات «أكمل تجهيزك» للسلة: تبدأ بالعلاقات التي ضبطها المدير، ثم تملأ الأماكن المتبقية من نفس
 * تصنيف منتجات السلة عندما يسمح المنتج المصدر بالتوصيات الآلية.
 */
export async function storefrontCartRecommendations(
  productIds: number[],
  branchIdInput?: number,
  limit = 4,
): Promise<StorefrontProduct[]> {
  const db = getDb();
  if (!db) return [];
  const sourceIds = Array.from(new Set(productIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))).slice(0, 24);
  if (!sourceIds.length) return [];
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  const cap = Math.min(Math.max(limit, 1), 8);
  const relationRows = await db
    .select({
      sourceProductId: productRelatedProducts.sourceProductId,
      relatedProductId: productRelatedProducts.relatedProductId,
      relationType: productRelatedProducts.relationType,
      sortOrder: productRelatedProducts.sortOrder,
      relationId: productRelatedProducts.id,
    })
    .from(productRelatedProducts)
    .where(and(inArray(productRelatedProducts.sourceProductId, sourceIds), eq(productRelatedProducts.isActive, true)))
    .orderBy(asc(productRelatedProducts.sortOrder), asc(productRelatedProducts.id));

  const sourceSet = new Set(sourceIds);
  const ranked = new Map<number, { score: number; relationId: number }>();
  const relationWeight: Record<string, number> = { COMPATIBLE: 0, COMPLETE_KIT: 1, SAME_THEME: 2, UPSELL: 3 };
  for (const row of relationRows) {
    const target = Number(row.relatedProductId);
    if (sourceSet.has(target)) continue;
    const score = Number(row.sortOrder ?? 0) * 10 + (relationWeight[String(row.relationType)] ?? 9);
    const previous = ranked.get(target);
    if (!previous || score < previous.score) ranked.set(target, { score, relationId: Number(row.relationId) });
  }
  const manualIds = Array.from(ranked.entries())
    .sort((a, b) => a[1].score - b[1].score || a[1].relationId - b[1].relationId)
    .slice(0, cap)
    .map(([id]) => id);

  const sourceRows = await db
    .select({ categoryId: products.categoryId, allowAutoCartRecommendations: products.allowAutoCartRecommendations })
    .from(products)
    .where(inArray(products.id, sourceIds));
  const autoCategoryIds = Array.from(new Set(
    sourceRows
      .filter((row) => row.allowAutoCartRecommendations !== false && row.categoryId != null)
      .map((row) => Number(row.categoryId))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  ));

  const manualItems: StorefrontProduct[] = [];
  if (manualIds.length) {
    const conds = [storefrontPublishableCondition(), inArray(products.id, manualIds)];
    const candidateRows = await availabilityCandidateSelect(db).where(and(...conds));
    const availableIds = chooseCandidateProductIds(await attachAvailability(db, branchId, candidateRows), cap, "IN_STOCK");
    const selectedOrder = new Map(manualIds.map((id, index) => [id, index]));
    const rawRows = await safeSelect(db).where(and(...conds, inArray(products.id, availableIds)));
    const rows = (await attachAvailability(db, branchId, rawRows))
      .filter((row) => row.availableQty >= Number(row.conversionFactor))
      .sort((a, b) => (selectedOrder.get(Number(a.productId)) ?? cap) - (selectedOrder.get(Number(b.productId)) ?? cap));
    const seen = new Set<number>();
    for (const row of rows) {
      const pid = Number(row.productId);
      if (seen.has(pid) || sourceSet.has(pid)) continue;
      seen.add(pid);
      manualItems.push(toStorefront(row));
      if (manualItems.length >= cap) break;
    }
  }

  const excludedIds = [...sourceIds, ...manualIds];
  const autoItems = manualItems.length >= cap || !autoCategoryIds.length
    ? []
    : await storefrontCategoryRecommendations(db, branchId, autoCategoryIds, excludedIds, cap - manualItems.length);
  const items = [...manualItems, ...autoItems].slice(0, cap);
  await applyStorefrontPromotions(items, branchId);
  await attachSoldCounts(db, items);
  await attachVariantColors(db, items, branchId);
  await attachStorefrontListMedia(db, items);
  return items;
}

/** توصيات آلية من تصنيفات منتجات السلة مع استبعاد المنتجات الموجودة والعلاقات اليدوية. */
async function storefrontCategoryRecommendations(
  db: NonNullable<ReturnType<typeof getDb>>,
  branchId: number,
  categoryIds: number[],
  excludedProductIds: number[],
  limit: number,
): Promise<StorefrontProduct[]> {
  if (!categoryIds.length || limit <= 0) return [];
  const cap = Math.min(Math.max(limit, 1), 8);
  const conds: SQL<unknown>[] = [storefrontPublishableCondition(), inArray(products.categoryId, categoryIds)];
  const excluded = new Set(excludedProductIds);
  const selectedIds = (await loadRankedStorefrontProductIds(db, branchId, conds, {
    availability: "IN_STOCK",
    categoryIds,
  })).filter((id) => !excluded.has(id)).slice(0, cap);
  if (!selectedIds.length) return [];
  const selectedOrder = new Map(selectedIds.map((id, index) => [id, index]));
  const rawRows = await safeSelect(db).where(and(...conds, inArray(products.id, selectedIds)));
  const rows = (await attachAvailability(db, branchId, rawRows))
    .filter((row) => row.availableQty >= Number(row.conversionFactor))
    .sort((a, b) =>
      (selectedOrder.get(Number(a.productId)) ?? cap) - (selectedOrder.get(Number(b.productId)) ?? cap)
      || Number(a.variantId) - Number(b.variantId)
      || Number(a.productUnitId) - Number(b.productUnitId));
  const seen = new Set<number>();
  const items: StorefrontProduct[] = [];
  for (const row of rows) {
    const pid = Number(row.productId);
    if (seen.has(pid) || excludedProductIds.includes(pid)) continue;
    seen.add(pid);
    items.push(toStorefront(row));
    if (items.length >= cap) break;
  }
  return items;
}

/**
 * منتجات ذات صلة (cross-sell «يُشترى معه»): نفس فئة المنتج، متوفّرة، مستثنى المنتج نفسه.
 * heuristic بسيط بلا سجلّ شراء — يرفع متوسط قيمة الطلب بتشجيع إضافة أصناف مكمّلة.
 */
export async function storefrontRelated(
  productId: number,
  branchIdInput?: number,
  limit = 8
): Promise<StorefrontProduct[]> {
  const db = getDb();
  if (!db) return [];
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  const cat = (await db.select({ categoryId: products.categoryId }).from(products).where(eq(products.id, productId)).limit(1))[0];
  const cap = Math.min(Math.max(limit, 1), 20);
  const seen = new Set<number>([productId]);
  const items: StorefrontProduct[] = [];
  const baseConds: SQL<unknown>[] = [storefrontPublishableCondition()];

  const appendCandidates = async (
    conds: SQL<unknown>[],
    categoryIds: readonly number[] | null,
    queryCap: number,
  ) => {
    if (items.length >= cap) return;
    const selectedIds = (await loadRankedStorefrontProductIds(db, branchId, conds, {
      availability: "IN_STOCK",
      categoryIds,
    }))
      .filter((id) => !seen.has(id))
      .slice(0, Math.min(Math.max(queryCap, 1), 20));
    if (!selectedIds.length) return;
    const selectedOrder = new Map(selectedIds.map((id, index) => [id, index]));
    const rawRows = await safeSelect(db).where(and(...conds, inArray(products.id, selectedIds)));
    const rows = (await attachAvailability(db, branchId, rawRows))
      .filter((row) => row.availableQty >= Number(row.conversionFactor))
      .sort((a, b) =>
        (selectedOrder.get(Number(a.productId)) ?? queryCap) - (selectedOrder.get(Number(b.productId)) ?? queryCap)
        || Number(b.availableQty >= Number(b.conversionFactor)) - Number(a.availableQty >= Number(a.conversionFactor))
        || Number(a.conversionFactor) - Number(b.conversionFactor)
        || Number(a.variantId) - Number(b.variantId)
        || Number(a.productUnitId) - Number(b.productUnitId));
    for (const row of rows) {
      const pid = Number(row.productId);
      if (seen.has(pid)) continue;
      seen.add(pid);
      items.push(toStorefront(row));
      if (items.length >= cap) break;
    }
  };

  // الأولوية للمنتجات من نفس الفئة، ثم إكمال الشريط من أي منتجات متاحة عند عدم كفاية الفئة.
  const categoryConds = cat?.categoryId == null
    ? baseConds
    : [...baseConds, eq(products.categoryId, Number(cat.categoryId))];
  const categoryIds = cat?.categoryId == null ? null : [Number(cat.categoryId)];
  await appendCandidates(categoryConds, categoryIds, cap);
  if (items.length < cap) await appendCandidates(baseConds, null, cap + seen.size);

  await applyStorefrontPromotions(items, branchId);
  await attachSoldCounts(db, items);
  await attachVariantColors(db, items, branchId);
  await attachStorefrontListMedia(db, items);
  return items;
}

export interface StorefrontOffer {
  id: number;
  name: string;
  type: "PERCENT" | "AMOUNT";
  discountPercent: string;
  discountAmount: string;
  scope: "ALL" | "CATEGORIES" | "PRODUCTS";
}

/** العروض الفعّالة اليوم (للبنرات) — نفس نافذة resolvePromotionForLine. */
export async function storefrontOffers(branchIdInput?: number): Promise<StorefrontOffer[]> {
  const db = getDb();
  if (!db) return [];
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  const todayYmd = todayYmdBaghdad();
  const rows = await db
    .select({
      id: promotions.id,
      name: promotions.name,
      type: promotions.type,
      discountPercent: promotions.discountPercent,
      discountAmount: promotions.discountAmount,
      scope: promotions.scope,
      priority: promotions.priority,
    })
    .from(promotions)
    .where(
      and(
        eq(promotions.isActive, true),
        sql`${promotions.effectiveFrom} <= DATE(${todayYmd})`,
        or(isNull(promotions.effectiveTo), sql`${promotions.effectiveTo} >= DATE(${todayYmd})`)!,
        or(isNull(promotions.branchId), eq(promotions.branchId, branchId))!,
        or(isNull(promotions.customerTier), eq(promotions.customerTier, RETAIL))!
      )
    )
    .orderBy(desc(promotions.priority), desc(promotions.id))
    .limit(10);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    type: r.type as "PERCENT" | "AMOUNT",
    discountPercent: String(r.discountPercent ?? "0"),
    discountAmount: String(r.discountAmount ?? "0"),
    scope: r.scope as "ALL" | "CATEGORIES" | "PRODUCTS",
  }));
}
