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
  branchStock,
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
  storefrontAvailableCondition,
  storefrontPublishableCondition,
} from "./storefrontEligibilityService";

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
function safeSelect(db: NonNullable<ReturnType<typeof getDb>>, branchId: number) {
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
      stockQty: branchStock.quantity, // داخلي فقط ⇒ inStock
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)))
    .leftJoin(productImages, and(eq(productImages.productId, products.id), eq(productImages.isPrimary, true)));
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
  imageId?: number | null; imageUrl: string | null; isBundle: boolean | null; stockQty: number | null;
}): StorefrontProduct {
  const factor = Math.max(1, Number(r.conversionFactor) || 1);
  const availableUnits = Math.floor(Number(r.stockQty ?? 0) / factor);
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
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      stockQty: branchStock.quantity,
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
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)))
    .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)))
    .orderBy(asc(productVariants.id));
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
    const inStock = evaluateStorefrontUnitEligibility({
      isActive: true,
      isStoreSaleUnit: true,
      retailPrice: r.retailPrice ?? null,
      conversionFactor: r.conversionFactor == null ? null : String(r.conversionFactor),
      stockBase: r.stockQty == null ? null : Number(r.stockQty),
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
  const availability = opts.availability ?? "IN_STOCK";
  const available = storefrontAvailableCondition();
  // IN_STOCK هو السلوك الافتراضي المتوافق. ALL يعيد كل المنشور ويترك inStock=false للنافد.
  const conds = [storefrontPublishableCondition()];
  if (availability === "IN_STOCK") conds.push(available);
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
  const rows = await safeSelect(db, branchId)
    .where(and(...conds))
    .orderBy(
      desc(available),
      desc(products.isFeatured),
      desc(sql`${productImages.url} is not null`),
      asc(products.name),
      asc(productUnits.conversionFactor),
    )
    .limit(cap * 3);

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
  return { items };
}

/** فئات المتجر: لا تختفي لمجرد نفاد المخزون؛ تُعيد المنشور والمتاح كلّاً على حدة. */
export async function storefrontCategories(branchIdInput?: number): Promise<StorefrontCategory[]> {
  const db = getDb();
  if (!db) return [];
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      productCount: sql<number>`COUNT(DISTINCT ${products.id})`,
      availableCount: sql<number>`COUNT(DISTINCT CASE WHEN ${branchStock.quantity} >= ${productUnits.conversionFactor} THEN ${products.id} END)`,
    })
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .innerJoin(
      productUnits,
      and(eq(productUnits.variantId, productVariants.id), eq(productUnits.isActive, true), eq(productUnits.isStoreSaleUnit, true))
    )
    .innerJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)))
    .innerJoin(categories, eq(products.categoryId, categories.id))
    // showInStore: يحترم إخفاء المدير للقسم من واجهة المتجر (لوحة hPanel)؛ والترتيب بـsortOrder.
    .where(and(
      storefrontPublishableCondition(),
      eq(categories.isActive, true),
      eq(categories.showInStore, true),
    ))
    .groupBy(categories.id, categories.name, categories.sortOrder)
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    productCount: Number(r.productCount),
    availableCount: Number(r.availableCount),
  }));
}

/** صفحة منتج واحد (تفاصيل آمنة + توفّر + سعر عرض). */
export async function storefrontProduct(productId: number, branchIdInput?: number): Promise<StorefrontProduct | null> {
  const db = getDb();
  if (!db) return null;
  const branchId = await resolveStorefrontBranchId(branchIdInput);
  const rows = await safeSelect(db, branchId)
    .where(and(storefrontPublishableCondition(), eq(products.id, productId)))
    .orderBy(desc(storefrontAvailableCondition()), asc(productUnits.conversionFactor));
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
  const rows = await safeSelect(db, branchId)
    .where(and(storefrontPublishableCondition(), eq(products.categoryId, Number(cat.categoryId)), ne(products.id, productId), storefrontAvailableCondition()))
    .orderBy(desc(sql`${productImages.url} is not null`), asc(products.name), asc(productUnits.conversionFactor))
    .limit(cap * 3);
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
