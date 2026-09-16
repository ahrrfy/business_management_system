/**
 * kioskService — قراءة آمنة للزبون لشاشة «قارئ الأسعار» (الكشك).
 *
 * مبدأ الأمان المالي: هذه الدوال تُغذّي شاشة يراها **الزبون**، فلا تُعيد أبداً
 * التكلفة (costPrice) ولا كمية المخزون ولا أسعار الجملة/الحكومي — فقط:
 * اسم المنتج، الماركة، الفئة، **سعر المفرد (RETAIL)**، الوحدة، الباركود، والصورة الرئيسية.
 * شرط التوفّر (المخزون > 0) يُطبَّق خادمياً للبنر دون كشف الكمية نفسها.
 */
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { branchStock, categories, productImages, productPrices, productUnits, productVariants, products, storeBanners } from "../../drizzle/schema";
import { getDb } from "../db";
import { decodeDataUrl, kioskProductImageUrl } from "../imageRoute";
import { resolveBarcodeOwner } from "./catalog/barcodeAliases";
import { resolvePromotionForLine } from "./salesPromotionService";
import { money, toDbMoney } from "./money";
import Decimal from "decimal.js";

/** شريحة ترويجية وإعلانية آمنة للزبون على شاشة الكشك. */
export interface KioskPromo {
  id: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
}

/** خيار وحدة بديلة (عبوة/درزن/كرتون) للسلعة المعروضة. */
export interface KioskUnitOption {
  unitName: string;
  conversionFactor: number;
  price: string | null;
  barcode: string | null;
}

/** صفّ عرض آمن للزبون — لا تكلفة ولا كمية مخزون. */
export interface KioskProduct {
  productId: number;
  productName: string;
  brand: string | null;
  category: string | null;
  variantName: string | null;
  unitName: string;
  /** سعر هذه الوحدة بفئة المفرد (RETAIL)؛ null = لا سعر مفرد مُعرَّف. */
  price: string | null;
  /** السعر الأصلي قبل الخصم إن كان هناك تخفيض فعّال. */
  originalPrice?: string | null;
  discountPercent?: string | null;
  promotionName?: string | null;
  barcode: string | null;
  /** صورة المنتج الرئيسية (data URL أو رابط)؛ null = لا صورة ⇒ تُعرض خانة بديلة. */
  imageUrl: string | null;
  /** عبوات ووحدات الصنف الأخرى وأسعارها. */
  availableUnits?: KioskUnitOption[];
}

const RETAIL = "RETAIL" as const;

const activeOnly = and(
  eq(products.isActive, true),
  // ٨/٧ (٢٦): استبعاد الخدمات من بنر الكشك — الخدمات (تصميم/طباعة/رسوم) لا معنى لعرضها
  // على شاشة أسعار للزبون؛ كتالوج المكتبة القابل للاقتناء فقط. البحث بالباركود لا يفلترها
  // لأن الخدمة لا تحمل باركوداً عادةً (والفلتر مشترك مع البنر بغرض الأمن).
  eq(products.isService, false),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true)
);

/** SELECT موحّد بالحقول الآمنة فقط — يُغذّي البنر والبحث بالباركود معاً. */
function kioskSelect(db: NonNullable<ReturnType<typeof getDb>>, branchId: number) {
  return db
    .select({
      productId: products.id,
      categoryId: products.categoryId,
      productName: products.name,
      brand: products.brand,
      category: categories.name,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
      price: productPrices.price,
      barcode: productUnits.barcode,
      imageId: productImages.id,
      imageUrl: productImages.url,
      stockBase: branchStock.quantity,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    // LEFT على الأسعار: نريد إرجاع المنتج في البحث حتى لو بلا سعر مفرد (price=null ⇒ تُعرض «اسأل الموظّف»).
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)))
    // الصورة الرئيسية فقط (1:0..1) — لا تكرار صفوف.
    .leftJoin(productImages, and(
      eq(productImages.productId, products.id),
      eq(productImages.isPrimary, true),
      eq(productImages.reviewStatus, "APPROVED"),
    ));
}

/**
 * صورة منتج الكشك كما تُرسَل للشاشة — **رابط** لا data URL (١٦/٧).
 *
 * السبب (أضخم من المتجر): `kioskBanner` سقفه **٥٠٠ منتج** وترتيبه «ذوات الصور أولاً» ⇒ ~٣٥٠ ك.ب
 * لكلٍّ ≈ **١٧٥ م.ب في ردٍّ JSON واحد** حين يمتلئ الكتالوج. رابطٌ بـ`immutable` يجعلها بايتاتٍ
 * تُجلَب مرّةً واحدة للأبد، والنافذة في `KioskView` تجلب المرئيّ منها فقط.
 *
 * العقد الثلاثيّ نفسه (درس #207): data URL ⇒ رابط | قيمة أخرى ⇒ **كما هي** | تالفة ⇒ null.
 */
function toKioskImage(imageId: number | null | undefined, value: string | null): string | null {
  if (!value) return null;
  if (!/^data:/i.test(value.trim())) return value;
  if (imageId == null) return null;
  return decodeDataUrl(value) ? kioskProductImageUrl(Number(imageId), value) : null;
}

function toKioskProduct(r: any): KioskProduct {
  return {
    productId: Number(r.productId),
    productName: r.productName,
    brand: r.brand ?? null,
    category: r.category ?? null,
    variantName: r.variantName ?? null,
    unitName: r.unitName,
    price: r.price ?? null,
    barcode: r.barcode ?? null,
    imageUrl: toKioskImage(r.imageId, r.imageUrl ?? null),
  };
}

/**
 * بنر الجذب (وضع «معرض تسويقي»): كل منتج بوحدة أساس فعّالة وسعر مفرد صريح — صفّ لكل منتج
 * مع الصورة، مرتّبة: ذوات الصور أولاً ثم أبجدياً. لا تُعيد الكمية.
 *
 * يُعيد **كامل الكتالوج** بلا سقف — البيانات الوصفية خفيفة (~٢٠٠ ب/منتج)، والصور تُحمَّل
 * بنافذة ٣ شرائح في العميل (isNearActive). الخلط يتمّ عميلياً عند كل دورة عرض كاملة.
 */
export async function kioskBanner(branchId: number): Promise<KioskProduct[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await kioskSelect(db, branchId)
    .where(and(activeOnly, eq(productUnits.isBaseUnit, true), sql`${productPrices.price} is not null`))
    .orderBy(desc(sql`${productImages.url} is not null`), asc(products.name));

  const seen = new Set<number>();
  const out: KioskProduct[] = [];
  for (const r of rows) {
    const pid = Number(r.productId);
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(toKioskProduct(r));
  }
  return out;
}

/**
 * بحث الباركود (المسح): يُطابق باركود أي وحدة (قطعة/درزن/كرتون) ويُعيد سعرها بفئة المفرد
 * مع اسم وحدتها — أو null إن لم يُعرَف الباركود. لا يشترط التوفّر (الزبون يريد السعر).
 */
export async function kioskLookup(barcode: string, branchId: number): Promise<KioskProduct | null> {
  const db = getDb();
  if (!db) return null;
  const code = String(barcode ?? "").trim();
  if (!code) return null;
  // البحث يمرّ على الأساسيّ والبديل معاً — البديل يعطي نفس السعر/الوحدة كالأساسيّ.
  const owner = await resolveBarcodeOwner(db, code);
  if (!owner) return null;
  const rows = await kioskSelect(db, branchId)
    .where(and(activeOnly, eq(productUnits.id, owner.productUnitId)))
    .limit(1);
  if (!rows.length) return null;

  const prod = toKioskProduct(rows[0]);

  // ١. فحص العروض والخصومات النشطة لفئة المفرد (نقطة العرض = نقطة الفرض)
  if (prod.price) {
    try {
      const todayYmd = new Date().toISOString().slice(0, 10);
      const promo = await resolvePromotionForLine(db as any, {
        branchId,
        customerTier: RETAIL,
        todayYmd,
        productId: owner.productId,
        variantId: owner.variantId,
        categoryId: rows[0].categoryId != null ? Number(rows[0].categoryId) : null,
        unitPrice: prod.price,
        lineAmount: prod.price,
        hasContractPrice: false,
      });
      if (promo) {
        const original = money(prod.price);
        const discount = money(promo.discountForUnit);
        if (discount.gt(0)) {
          prod.originalPrice = prod.price;
          const effective = original.minus(discount);
          prod.price = toDbMoney(effective.isNegative() ? new Decimal(0) : effective);
          const pct = discount.div(original).mul(100).round();
          prod.discountPercent = String(pct.toNumber());
          prod.promotionName = promo.promotionName;
        }
      }
    } catch {
      // إخفاق صامت لحساب الخصم لضمان عرض السعر الأساسي دائماً
    }
  }

  // ٢. جلب خيارات العبوات والوحدات المتعددة لنفس المتغير (قطعة/درزن/كرتون)
  try {
    const sisterUnits = await db
      .select({
        unitName: productUnits.unitName,
        conversionFactor: productUnits.conversionFactor,
        price: productPrices.price,
        barcode: productUnits.barcode,
      })
      .from(productUnits)
      .leftJoin(
        productPrices,
        and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL))
      )
      .where(and(eq(productUnits.variantId, owner.variantId), eq(productUnits.isActive, true)))
      .orderBy(asc(productUnits.conversionFactor));

    if (sisterUnits.length > 1) {
      prod.availableUnits = sisterUnits.map((u) => ({
        unitName: u.unitName,
        conversionFactor: Number(u.conversionFactor ?? 1),
        price: u.price ?? null,
        barcode: u.barcode ?? null,
      }));
    }
  } catch {
    // إخفاق صامت للوحدات البديلة
  }

  return prod;
}

/**
 * البنرات الترويجية الفعّالة للفرع أو العامة (branchId is null) لعرضها في الكشك بالتناوب.
 */
export async function kioskPromotions(branchId?: number | null): Promise<KioskPromo[]> {
  const db = getDb();
  if (!db) return [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: storeBanners.id,
      title: storeBanners.title,
      subtitle: storeBanners.subtitle,
      imageUrl: storeBanners.imageUrl,
      ctaLabel: storeBanners.ctaLabel,
    })
    .from(storeBanners)
    .where(
      and(
        eq(storeBanners.isActive, true),
        or(isNull(storeBanners.effectiveFrom), sql`${storeBanners.effectiveFrom} <= ${today}`),
        or(isNull(storeBanners.effectiveTo), sql`${storeBanners.effectiveTo} >= ${today}`),
        branchId != null
          ? or(isNull(storeBanners.branchId), eq(storeBanners.branchId, branchId))
          : isNull(storeBanners.branchId)
      )
    )
    .orderBy(asc(storeBanners.sortOrder), desc(storeBanners.id))
    .limit(10);

  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    subtitle: r.subtitle ?? null,
    imageUrl: r.imageUrl ?? null,
    ctaLabel: r.ctaLabel ?? null,
  }));
}

