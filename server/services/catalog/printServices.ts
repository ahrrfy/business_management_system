// خدمات الطباعة (نقطة بيع الخدمات).
import { and, asc, eq } from "drizzle-orm";
import { categories, productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { PriceTier } from "../pricing";
import { titleForChannel } from "@shared/productChannelTitles";

/** خدمة طباعة قابلة للبيع: (متغيّر الخدمة × وحدة الأساس) بسعر الفئة + فئتها. لا تحمل كلفة/مواد
 *  (شأن إداري لا يراه الكاشير). price=null ⇒ سعر يدوي يُدخله الكاشير. */
export interface PrintServiceRow {
  productId: number;
  productName: string;
  variantId: number;
  sku: string;
  productUnitId: number;
  unitName: string;
  categoryId: number | null;
  categoryName: string | null;
  price: string | null;
}

/** قائمة خدمات قسم الطباعة مع سعر الفئة + اسم الفئة — تغذّي شبكة بلاطات الشاشة.
 *
 * الفلترة (٢٤/٨، هجرة 0262): `showInPrintPos=TRUE` — قرارٌ مستقلٌّ يضبطه المدير للمنتج،
 * لا يُلبس المفهوم بحقلٍ آخر (`productType`) استُعمل لتصنيفاتٍ أخرى (DIGITAL_CARD…) فحُشِرت
 * الرؤية معه صامتاً. قبل الهجرة كان الفلتر `productType='PRINT_SERVICE'` STRICT ⇒ خدماتٌ
 * قديمةٌ (بلا productType) أو مُستوردة تختفي من الشبكة رغم كونها `isService=true`.
 * التعبئة الخلفيّة في الهجرة تُبقي كلّ خدمةٍ مؤهَّلة ظاهرة.
 */
export async function listPrintServices(tier: PriceTier): Promise<PrintServiceRow[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      invoiceLabel: products.invoiceLabel,
      shortTitle: products.shortTitle,
      variantId: productVariants.id,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      categoryId: products.categoryId,
      categoryName: categories.name,
      price: productPrices.price,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(productPrices, and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, tier)))
    .where(
      and(
        eq(products.isActive, true),
        eq(productVariants.isActive, true),
        eq(productUnits.isActive, true),
        eq(productUnits.isBaseUnit, true),
        eq(products.showInPrintPos, true)
      )
    )
    .orderBy(asc(products.categoryId), asc(products.id));
  return rows.map((r) => ({
    productId: Number(r.productId),
    productName: titleForChannel({ name: r.productName, invoiceLabel: r.invoiceLabel, shortTitle: r.shortTitle }, "invoice"),
    variantId: Number(r.variantId),
    sku: r.sku,
    productUnitId: Number(r.productUnitId),
    unitName: r.unitName,
    categoryId: r.categoryId != null ? Number(r.categoryId) : null,
    categoryName: r.categoryName ?? null,
    price: r.price ?? null,
  }));
}
