/**
 * kioskService — قراءة آمنة للزبون لشاشة «قارئ الأسعار» (الكشك).
 *
 * مبدأ الأمان المالي: هذه الدوال تُغذّي شاشة يراها **الزبون**، فلا تُعيد أبداً
 * التكلفة (costPrice) ولا كمية المخزون ولا أسعار الجملة/الحكومي — فقط:
 * اسم المنتج، الماركة، الفئة، **سعر المفرد (RETAIL)**، الوحدة، الباركود، والصورة الرئيسية.
 * شرط التوفّر (المخزون > 0) يُطبَّق خادمياً للبنر دون كشف الكمية نفسها.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { branchStock, categories, productImages, productPrices, productUnits, productVariants, products, storeBanners } from "../../drizzle/schema";
import { getDb } from "../db";
import { decodeDataUrl, kioskProductImageUrl } from "../imageRoute";
import { shortHash } from "../lib/imageStore";
import { resolveBarcodeOwner } from "./catalog/barcodeAliases";
import { resolvePromotionForLine } from "./salesPromotionService";
import { todayYmdBaghdad } from "../../shared/promotionScheduling";
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
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      productUnitId: productUnits.id,
      isBaseUnit: productUnits.isBaseUnit,
      isBundle: products.isBundle,
      unitName: productUnits.unitName,
      price: productPrices.price,
      barcode: productUnits.barcode,
      stockBase: branchStock.quantity,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    // LEFT على الأسعار: نريد إرجاع المنتج في البحث حتى لو بلا سعر مفرد (price=null ⇒ تُعرض «اسأل الموظّف»).
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, RETAIL)))
    .leftJoin(branchStock, and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)));
}

type KioskImageRow = {
  id: number;
  productId: number;
  variantId: number | null;
  url: string;
  objectKey: string | null;
  contentHash: string | null;
  thumbDataUrl: string | null;
};

async function loadKioskImagesByProduct(
  db: NonNullable<ReturnType<typeof getDb>>,
  productIds: number[],
): Promise<Map<number, KioskImageRow[]>> {
  const uniqueIds = Array.from(new Set(productIds)).filter((id) => Number.isFinite(id) && id > 0);
  if (!uniqueIds.length) return new Map();
  const rows = await db
    .select({
      id: productImages.id,
      productId: productImages.productId,
      variantId: productImages.variantId,
      url: productImages.url,
      objectKey: productImages.objectKey,
      contentHash: productImages.contentHash,
      thumbDataUrl: productImages.thumbDataUrl,
    })
    .from(productImages)
    .where(and(inArray(productImages.productId, uniqueIds), eq(productImages.reviewStatus, "APPROVED")))
    .orderBy(desc(productImages.isPrimary), asc(productImages.sortOrder), desc(productImages.id));
  const map = new Map<number, KioskImageRow[]>();
  for (const r of rows) {
    const pid = Number(r.productId);
    const item: KioskImageRow = {
      id: Number(r.id),
      productId: pid,
      variantId: r.variantId == null ? null : Number(r.variantId),
      url: r.url,
      objectKey: r.objectKey,
      contentHash: r.contentHash,
      thumbDataUrl: r.thumbDataUrl,
    };
    const list = map.get(pid);
    if (list) list.push(item);
    else map.set(pid, [item]);
  }
  return map;
}

/**
 * صورة منتج الكشك كما تُرسَل للشاشة — **رابط `/api/img/kiosk-product/...`** لا `/api/img/product/...`
 * حتى تعمل المنتجات المخفية عن المتجر (`showInStore = 0`) في الكشك بلا 404.
 */
function toKioskImage(img: KioskImageRow | null | undefined): string | null {
  if (!img) return null;
  if (img.objectKey && img.contentHash && /^[0-9a-f]{64}$/i.test(img.contentHash)) {
    return `/api/img/kiosk-product/${img.id}?v=${shortHash(img.contentHash)}`;
  }
  const value = img.url?.trim() ?? "";
  if (value) {
    if (/^data:/i.test(value)) {
      return decodeDataUrl(value) ? kioskProductImageUrl(img.id, value) : (img.thumbDataUrl ?? null);
    }
    const publicMatch = /^\/api\/img\/(?:company\/[^/]+\/)?product\/(\d+)(?:\?([^#]*))?$/i.exec(value);
    if (publicMatch) {
      const params = new URLSearchParams(publicMatch[2] ?? "");
      const v = params.get("v");
      if (v && /^[0-9a-f]{16}$/i.test(v)) {
        return `/api/img/kiosk-product/${publicMatch[1]}?v=${v.toLowerCase()}`;
      }
      return img.thumbDataUrl ?? null;
    }
    return value;
  }
  return img.thumbDataUrl ?? null;
}

function pickKioskImageForVariant(
  imagesByProduct: Map<number, KioskImageRow[]>,
  productId: number,
  variantId: number | null,
  allowSiblingFallback = false,
): KioskImageRow | null {
  const list = imagesByProduct.get(productId) ?? [];
  if (!list.length) return null;
  const varImg = variantId != null ? list.find((img) => img.variantId === variantId) : undefined;
  const parentImg = list.find((img) => img.variantId == null);
  return varImg ?? parentImg ?? (allowSiblingFallback ? list[0] : null);
}

function toKioskProduct(r: any, imageRow: KioskImageRow | null): KioskProduct {
  return {
    productId: Number(r.productId),
    productName: r.productName,
    brand: r.brand ?? null,
    category: r.category ?? null,
    variantName: r.variantName ?? null,
    unitName: r.unitName,
    price: r.price ?? null,
    barcode: r.barcode ?? null,
    imageUrl: toKioskImage(imageRow),
  };
}

/**
 * بنر الجذب (وضع «معرض تسويقي»): كل منتج بوحدة أساس فعّالة وسعر مفرد صريح — صفّ لكل منتج
 * مع الصورة، مرتّبة: ذوات الصور أولاً ثم أبجدياً. لا تُعيد الكمية.
 */
export async function kioskBanner(branchId: number): Promise<KioskProduct[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await kioskSelect(db, branchId)
    .where(and(activeOnly, eq(productUnits.isBaseUnit, true), sql`${productPrices.price} is not null`))
    .orderBy(asc(products.name));

  const imagesByProduct = await loadKioskImagesByProduct(
    db,
    rows.map((r) => Number(r.productId)),
  );
  const byProduct = new Map<number, { row: (typeof rows)[number]; imageRow: KioskImageRow | null }>();
  for (const r of rows) {
    const pid = Number(r.productId);
    const vid = r.variantId != null ? Number(r.variantId) : null;
    const imgRow = pickKioskImageForVariant(imagesByProduct, pid, vid, true);
    const existing = byProduct.get(pid);
    if (!existing || (!existing.imageRow && imgRow)) {
      byProduct.set(pid, { row: r, imageRow: imgRow });
    }
  }
  const out = Array.from(byProduct.values()).map(({ row, imageRow }) => toKioskProduct(row, imageRow));
  out.sort((a, b) => Number(Boolean(b.imageUrl)) - Number(Boolean(a.imageUrl)));
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

  const imagesByProduct = await loadKioskImagesByProduct(db, [Number(rows[0].productId)]);
  const imgRow = pickKioskImageForVariant(
    imagesByProduct,
    Number(rows[0].productId),
    rows[0].variantId != null ? Number(rows[0].variantId) : null,
  );
  const prod = toKioskProduct(rows[0], imgRow);

  // ١. فحص العروض والخصومات النشطة لفئة المفرد (نقطة العرض = نقطة الفرض)
  if (prod.price) {
    try {
      const todayYmd = todayYmdBaghdad();
      const promo = await resolvePromotionForLine(db as any, {
        branchId,
        customerTier: RETAIL,
        todayYmd,
        productId: owner.productId,
        variantId: owner.variantId,
        productUnitId: Number(rows[0].productUnitId),
        isBaseUnit: Boolean(rows[0].isBaseUnit),
        isBundle: Boolean(rows[0].isBundle),
        categoryId: rows[0].categoryId != null ? Number(rows[0].categoryId) : null,
        unitPrice: prod.price,
        lineAmount: prod.price,
        quantity: 1,
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
  const today = todayYmdBaghdad();
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

