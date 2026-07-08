/**
 * kioskService — قراءة آمنة للزبون لشاشة «قارئ الأسعار» (الكشك).
 *
 * مبدأ الأمان المالي: هذه الدوال تُغذّي شاشة يراها **الزبون**، فلا تُعيد أبداً
 * التكلفة (costPrice) ولا كمية المخزون ولا أسعار الجملة/الحكومي — فقط:
 * اسم المنتج، الماركة، الفئة، **سعر المفرد (RETAIL)**، الوحدة، الباركود، والصورة الرئيسية.
 * شرط التوفّر (المخزون > 0) يُطبَّق خادمياً للبنر دون كشف الكمية نفسها.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { branchStock, categories, productImages, productPrices, productUnits, productVariants, products } from "../../drizzle/schema";
import { getDb } from "../db";
import { resolveBarcodeOwner } from "./catalog/barcodeAliases";

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
  barcode: string | null;
  /** صورة المنتج الرئيسية (data URL أو رابط)؛ null = لا صورة ⇒ تُعرض خانة بديلة. */
  imageUrl: string | null;
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
      productName: products.name,
      brand: products.brand,
      category: categories.name,
      variantName: productVariants.variantName,
      unitName: productUnits.unitName,
      price: productPrices.price,
      barcode: productUnits.barcode,
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
    .leftJoin(productImages, and(eq(productImages.productId, products.id), eq(productImages.isPrimary, true)));
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
    imageUrl: r.imageUrl ?? null,
  };
}

/**
 * بنر الجذب (وضع «معرض تسويقي»): كل منتج بوحدة أساس فعّالة وسعر مفرد صريح — صفّ لكل منتج
 * مع الصورة، مرتّبة: ذوات الصور أولاً ثم أبجدياً. لا تُعيد الكمية.
 *
 * **قرار المالك (٨/٧):** حُذف شرط «مخزون الفرع > 0» ليعرض البنر الكتالوج فوراً بينما يُدخَل
 * المخزون تدريجياً بعد مسح ٥/٧. يقبل هذا التنازل احتمال ظهور منتج قد لا يكون على الرفّ؛
 * لكنّ مسح الباركود يبقى دقيقاً (`kioskLookup` لا يشترط المخزون أصلاً — الزبون يعرف السعر عند المسح).
 *
 * **ملاحظة نطاق الفرع:** بحذف شرط المخزون، `branchId` لم يعُد يُقيّد الكتالوج (كتالوج المنتجات
 * مشترك بين الفروع في هذا النشاط). يبقى المعامل جزءاً من التوقيع لتوافق النداء الحالي — ولإعادة
 * تفعيل الشرط لاحقاً بإضافة `gt(branchStock.quantity, 0)` سطراً واحداً بعد إدخال المخزون.
 */
export async function kioskBanner(branchId: number, limit = 500): Promise<KioskProduct[]> {
  const db = getDb();
  if (!db) return [];
  // سقف ٥٠٠: يستوعب كتالوج مكتبة نموذجي كاملاً، ويحمي من كوارث الأداء إن نما إلى آلاف.
  const cap = Math.min(Math.max(limit, 1), 500);
  const rows = await kioskSelect(db, branchId)
    .where(and(activeOnly, eq(productUnits.isBaseUnit, true), sql`${productPrices.price} is not null`))
    .orderBy(desc(sql`${productImages.url} is not null`), asc(products.name))
    .limit(cap * 2); // فائض لاستيعاب إزالة التكرار

  // منتج واحد لكل بطاقة (متغيّرات متعدّدة لنفس المنتج تُختصر لأول ظهور).
  const seen = new Set<number>();
  const out: KioskProduct[] = [];
  for (const r of rows) {
    const pid = Number(r.productId);
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(toKioskProduct(r));
    if (out.length >= cap) break;
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
  return rows.length ? toKioskProduct(rows[0]) : null;
}
