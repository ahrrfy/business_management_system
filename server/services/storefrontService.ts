/**
 * storefrontService — كتالوج آمن **علني** (بلا مصادقة) لمتجر الزبون على الجوال (B2C).
 *
 * ⚠️ أمن مالي حاكم (نظير kioskService): بيانات يراها الزبون على الإنترنت ⇒ لا تُعيد أبداً
 * التكلفة ولا **كمية** المخزون ولا أسعار الجملة/الحكومي — فقط الحقول التسويقية الآمنة +
 * **توفّر** (inStock: نعم/لا، لا الكمية) + **سعر العرض** بعد الخصم إن وُجد.
 *
 * 🔗 مزامنة حقيقية مع النظام (لا بيانات منفصلة): يقرأ نفس جداول `products/productPrices/branchStock`
 * ويطبّق **نفس محرّك العروض** (`resolvePromotionForLine`) المستعمل في نقطة البيع — فالسعر المعروض
 * = السعر المفروض (نقطة العرض = نقطة الفرض)، وطلب الزبون يُعاد تسعيره بنفس المحرّك خادمياً.
 */
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  bundleComponents,
  categories,
  invoiceItems,
  productImages,
  productPrices,
  productUnits,
  productVariants,
  products,
  promotions,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { decodeDataUrl, productImageUrl } from "../imageRoute";
import { withTx } from "./tx";
import { money, toDbMoney } from "./money";
import { getProductCategoryIds, resolvePromotionForLine } from "./salesPromotionService";
import { resolveColorHex, normalizeHex } from "@shared/colorBank";
import { requireActiveBranch, requireStorefrontContext } from "./storefrontContextService";
import {
  evaluateStorefrontUnitEligibility,
  storefrontPublishableCondition,
} from "./storefrontEligibilityService";
import { loadVariantAvailability } from "./catalog/variantAvailability";

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

/** صفّ عرض آمن للزبون — لا تكلفة ولا كمية مخزون ولا أسعار جملة/حكومي. */
export interface StorefrontProduct {
  productId: number;
  /** مُعرّف وحدة الأساس — يحتاجه سطر الطلب (createOrder). مُعرّف فقط، لا حقل حسّاس. */
  productUnitId: number;
  variantId: number;
  productName: string;
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
  color: string | null;
  colorHex: string | null;
  size: string | null;
  inStock: boolean;
  units: StorefrontUnitOption[];
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

/** SELECT موحّد بالحقول الآمنة + كمية الفرع (داخلياً لحساب inStock فقط، لا تُصدَّر). */
function safeSelect(db: NonNullable<ReturnType<typeof getDb>>) {
  return db
    .select({
      productId: products.id,
      productUnitId: productUnits.id,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      size: productVariants.size,
      productName: products.name,
      brand: products.brand,
      category: categories.name,
      categoryId: products.categoryId,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      price: productPrices.price,
      imageId: productImages.id,
      imageUrl: productImages.url,
      isBundle: products.isBundle,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .leftJoin(productImages, and(
      eq(productImages.productId, products.id),
      eq(productImages.isPrimary, true),
      eq(productImages.reviewStatus, "APPROVED"),
    ));
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
      imageId: productImages.id,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .leftJoin(productImages, and(
      eq(productImages.productId, products.id),
      eq(productImages.isPrimary, true),
      eq(productImages.reviewStatus, "APPROVED"),
    ));
}

function chooseCandidateProductIds(
  rows: Array<{
    productId: number;
    conversionFactor: string;
    isFeatured: boolean | null;
    productName: string;
    imageId: number | null;
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
      current.hasImage ||= row.imageId != null;
    } else {
      productsById.set(id, {
        id,
        inStock,
        featured: row.isFeatured === true,
        hasImage: row.imageId != null,
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
function toPublicProductImage(imageId: number | null | undefined, value: string | null): string | null {
  if (!value) return null;
  if (!/^data:/i.test(value.trim())) return value;
  if (imageId == null) return null;
  return decodeDataUrl(value) ? productImageUrl(Number(imageId), value) : null;
}

function toStorefront(r: {
  productId: number; productUnitId: number; variantId: number; productName: string; brand: string | null;
  variantName: string | null; color: string | null; colorHex: string | null; size: string | null;
  category: string | null; categoryId: number | null; unitName: string; conversionFactor: string; price: string | null;
  imageId?: number | null; imageUrl: string | null; isBundle: boolean | null;
  stockQty: number; reservedQty: number; availableQty: number; hasStockRow: boolean;
}): StorefrontProduct {
  const factor = Math.max(1, Number(r.conversionFactor) || 1);
  const availableUnits = Math.floor(r.availableQty / factor);
  return {
    productId: Number(r.productId),
    productUnitId: Number(r.productUnitId),
    variantId: Number(r.variantId),
    productName: r.productName,
    brand: r.brand ?? null,
    category: r.category ?? null,
    categoryId: r.categoryId != null ? Number(r.categoryId) : null,
    unitName: r.unitName,
    price: r.price ?? null,
    salePrice: null,
    promotionName: null,
    inStock: availableUnits > 0,
    imageUrl: toPublicProductImage(r.imageId, r.imageUrl ?? null),
    isBundle: !!r.isBundle,
    stockLeft: availableUnits > 0 && availableUnits <= LOW_STOCK_THRESHOLD ? availableUnits : null,
    soldCount: 0,
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

/** الدليل الاجتماعي: يُرفق عدد مرّات بيع كل منتج (COUNT فواتير مميّزة) — استعلام مجمَّع واحد. */
async function attachSoldCounts(
  db: NonNullable<ReturnType<typeof getDb>>,
  items: StorefrontProduct[]
): Promise<void> {
  if (!items.length) return;
  const productIds = items.map((i) => i.productId);
  const rows = await db
    .select({ productId: productVariants.productId, n: sql<number>`COUNT(DISTINCT ${invoiceItems.invoiceId})` })
    .from(invoiceItems)
    .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
    .where(inArray(productVariants.productId, productIds))
    .groupBy(productVariants.productId);
  const map = new Map(rows.map((r) => [Number(r.productId), Number(r.n)]));
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
 * يطبّق العروض على قائمة منتجات (نفس محرّك POS ⇒ العرض = الفرض). حارس أداء: إن لا عرض
 * فعّال اليوم ⇒ يعود بلا مسح لكل منتج (استعلام واحد رخيص). وإلّا يحلّ العرض الأنسب لكلٍّ.
 */
async function applyStorefrontPromotions(list: StorefrontProduct[], branchId: number): Promise<void> {
  const eligible = list.filter((p) => p.price != null);
  if (!eligible.length) return;
  const db = getDb();
  if (!db) return;
  const todayYmd = todayYmdBaghdad();
  // حارس: هل يوجد أيّ عرض فعّال اليوم على هذا الفرع/فئة المفرد؟ (لا ⇒ تخطّي كامل.)
  const anyActive = await db
    .select({ id: promotions.id })
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
    .limit(1);
  if (!anyActive.length) return;

  await withTx(async (tx) => {
    const catByProduct = await getProductCategoryIds(tx, Array.from(new Set(eligible.map((p) => p.productId))));
    for (const p of eligible) {
      const price = money(p.price!);
      const res = await resolvePromotionForLine(tx, {
        branchId,
        customerTier: RETAIL,
        productId: p.productId,
        variantId: p.variantId,
        categoryId: catByProduct.get(p.productId) ?? p.categoryId ?? null,
        unitPrice: price.toFixed(2),
        lineAmount: price.toFixed(2),
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true, // 0073: المتجر يُدرِج عروضه المتجرية (أونلاين) بخلاف الكاشير
      });
      if (res) {
        const eff = price.minus(money(res.discountForUnit));
        p.salePrice = toDbMoney(eff.lt(0) ? money(0) : eff);
        p.promotionName = res.promotionName;
      }
    }
  });
}

/** كتالوج المتجر: منتجات قابلة للاقتناء (بطاقة لكل منتج) + توفّر + سعر عرض. المتوفّر أولاً. */
export async function storefrontCatalog(opts: {
  branchId?: number;
  categoryId?: number | null;
  search?: string | null;
  limit?: number;
  availability?: StorefrontAvailability;
}): Promise<{ items: StorefrontProduct[] }> {
  const db = getDb();
  if (!db) return { items: [] };
  const branchId = await resolveStorefrontBranchId(opts.branchId);
  const cap = Math.min(Math.max(opts.limit ?? 60, 1), 120);
  const availabilityFilter = opts.availability ?? "IN_STOCK";
  // IN_STOCK هو السلوك الافتراضي المتوافق. ALL يعيد كل المنشور ويترك inStock=false للنافد.
  const conds = [storefrontPublishableCondition()];
  if (opts.categoryId != null) conds.push(eq(products.categoryId, opts.categoryId));
  const s = String(opts.search ?? "").trim();
  if (s) {
    // تدقيق ٣/٨: تهريب `%`/`_` (escLike + ESCAPE '!') كبقية مسارات البحث — كان بحث «%» يطابق كل
    // شيء ويفرض مسحاً كاملاً (اتساق/أداء؛ القيمة مربوطة أصلاً فلا حقن).
    const p = `%${escLike(s)}%`;
    const searchCond = or(
      sql`${products.name} LIKE ${p} ESCAPE '!'`,
      sql`${products.brand} LIKE ${p} ESCAPE '!'`,
      sql`${productUnits.barcode} LIKE ${p} ESCAPE '!'`,
    );
    if (searchCond) conds.push(searchCond);
  }
  const candidateRows = await availabilityCandidateSelect(db).where(and(...conds));
  const hydratedCandidates = await attachAvailability(db, branchId, candidateRows);
  const selectedIds = chooseCandidateProductIds(hydratedCandidates, cap, availabilityFilter);
  if (!selectedIds.length) return { items: [] };
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

  const seen = new Set<number>();
  const items: StorefrontProduct[] = [];
  for (const r of rows) {
    const pid = Number(r.productId);
    if (seen.has(pid)) continue;
    seen.add(pid);
    items.push(toStorefront(r));
    if (items.length >= cap) break;
  }
  await applyStorefrontPromotions(items, branchId);
  await attachSoldCounts(db, items);
  await attachVariantColors(db, items, branchId);
  await attachBundleComponentImages(db, items);
  return { items };
}

/** فئات المتجر: لا تختفي لمجرد نفاد المخزون؛ تُعيد المنشور والمتاح كلّاً على حدة. */
export async function storefrontCategories(branchIdInput?: number): Promise<StorefrontCategory[]> {
  const db = getDb();
  if (!db) return [];
  const branchId = await resolveStorefrontBranchId(branchIdInput);
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
        color: source.color?.trim() || null,
        colorHex: normalizeHex(source.colorHex) ?? resolveColorHex(source.color ?? "") ?? null,
        size: source.size?.trim() || null,
        inStock: false,
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
  if (!cat || cat.categoryId == null) return [];
  const cap = Math.min(Math.max(limit, 1), 20);
  const conds = [
    storefrontPublishableCondition(),
    eq(products.categoryId, Number(cat.categoryId)),
    ne(products.id, productId),
  ];
  const candidateRows = await availabilityCandidateSelect(db).where(and(...conds));
  const selectedIds = chooseCandidateProductIds(
    await attachAvailability(db, branchId, candidateRows),
    cap,
    "IN_STOCK",
  );
  if (!selectedIds.length) return [];
  const selectedOrder = new Map(selectedIds.map((id, index) => [id, index]));
  const rawRows = await safeSelect(db).where(and(...conds, inArray(products.id, selectedIds)));
  const rows = (await attachAvailability(db, branchId, rawRows))
    .filter((row) => row.availableQty >= Number(row.conversionFactor))
    .sort((a, b) =>
      (selectedOrder.get(Number(a.productId)) ?? cap) - (selectedOrder.get(Number(b.productId)) ?? cap)
      || Number(b.availableQty >= Number(b.conversionFactor)) - Number(a.availableQty >= Number(a.conversionFactor))
      || Number(a.conversionFactor) - Number(b.conversionFactor)
      || Number(a.variantId) - Number(b.variantId)
      || Number(a.productUnitId) - Number(b.productUnitId));
  const seen = new Set<number>();
  const items: StorefrontProduct[] = [];
  for (const r of rows) {
    const pid = Number(r.productId);
    if (seen.has(pid)) continue;
    seen.add(pid);
    items.push(toStorefront(r));
    if (items.length >= cap) break;
  }
  await applyStorefrontPromotions(items, branchId);
  await attachSoldCounts(db, items);
  await attachVariantColors(db, items, branchId);
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
