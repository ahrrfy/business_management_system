// أدوات البحث والرؤية المشتركة (POS/الشراء/الإدارة) — لا تُصدَّر من نقطة الدخول العامة.
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { productUnitBarcodes, productUnits, productVariants, products } from "../../../drizzle/schema";
import { ARABIC_FOLD_PAIRS, normalizeSearchText, tokenizeSearchQuery } from "../../../shared/searchNormalize";
import { escLike } from "../../lib/sqlLike";
import { PRINT_SERVICE_TYPE } from "../printSaleService";

// خدمات الطباعة (productType=PRINT_SERVICE) مُستثناة من كاشير الباركود/الشراء: لا مخزون لها،
// وتُباع عبر شاشة «نقطة بيع الطباعة» فقط. (NULL = منتج عادي ⇒ يبقى ظاهراً.)
const DIGITAL_CARD_TYPE = "DIGITAL_CARD";
const ordinaryCatalogProduct = sql`(
  ${products.productType} IS NULL OR
  (${products.productType} <> ${PRINT_SERVICE_TYPE} AND ${products.productType} <> ${DIGITAL_CARD_TYPE})
)`;
const activeOnly = and(
  eq(products.isActive, true),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true),
  ordinaryCatalogProduct
);

// رؤية كاشير الاستقبال: كالعادي + خدمات الطباعة المفعَّل عليها showInReception (تُباع عبر createPrintSale).
const receptionVisible = sql`(
  ${products.productType} IS NULL OR
  (${products.productType} <> ${PRINT_SERVICE_TYPE} AND ${products.productType} <> ${DIGITAL_CARD_TYPE}) OR
  (${products.productType} = ${PRINT_SERVICE_TYPE} AND ${products.showInReception} = TRUE)
)`;
// رؤية فاتورة البيع المتقدّمة (١٢/٨/٢٦): كل خدمات الطباعة **بلا شرط showInReception** — الفاتورة الرسمية
// قد تجمع سلعاً وخدماتٍ (شركات/حكومي). createSale يخصم موادها ذرّياً + يحتسب COGS من الوصفة. البطاقات
// الرقميّة تُستثنى دائماً (منظومتها المستقلّة). isActive على المنتج/المتغيّر/الوحدة يبقى نافذاً.
const advancedSaleVisible = sql`(
  ${products.productType} IS NULL OR ${products.productType} <> ${DIGITAL_CARD_TYPE}
)`;
function posVisibility(mode: "default" | "reception" | "advancedSale") {
  const baseConds = [
    eq(products.isActive, true),
    eq(productVariants.isActive, true),
    eq(productUnits.isActive, true),
  ];
  return and(
    ...baseConds,
    mode === "advancedSale" ? advancedSaleVisible : mode === "reception" ? receptionVisible : ordinaryCatalogProduct,
  );
}

/**
 * تعبير SQL يطبّع عموداً نصياً بنفس جدول التطبيع المشترك (ARABIC_FOLD_PAIRS) —
 * الجهتان (العمود + الاستعلام) تُطبَّعان بنفس القواعد فتتم المطابقة في فضاء موحَّد:
 * «ازرق» يجد «أزرق»، و«مكتبه» تجد «مكتبة».
 */
function foldedCol(col: MySqlColumn): SQL {
  let expr = sql`lower(coalesce(${col}, ''))`;
  for (const [from, to] of ARABIC_FOLD_PAIRS) {
    expr = sql`replace(${expr}, ${from}, ${to})`;
  }
  return expr;
}

/** الأعمدة القابلة للبحث في الكتالوج — مصدر واحد لبُنية الشرط والترتيب.
 *  D2 (٣٠/٦ كامل): products.searchNorm = عمود مولَّد STORED بتطبيع عربي (هَجرة 0035
 *  مُطبَّقة عبر db:migrate:safe إنتاجياً، أو db:migrate:extra في CI بَعد db:push).
 *  ⇒ يُلغي ٩ REPLACE وقت الاستعلام على products.name لكل صفّ ⇒ ٥-١٠× أسرع بدون فهرس،
 *  وآلاف المرات أسرع للـprefix searches (LIKE 'abc%') عبر فهرس B-tree الجَديد. */
function searchableCols(): SQL[] {
  return [
    sql`coalesce(${products.searchNorm}, '')`,
    foldedCol(productVariants.sku),
    foldedCol(productVariants.variantName),
    foldedCol(productUnits.barcode),
  ];
}

/**
 * مطابقة باركود بديل للوحدة الحالية من دون JOIN يضاعف صفوف الكتالوج ويشوّه الترقيم.
 * لا نقيّد البديل بنشاط الوحدة: الباركود المسجّل يبقى هويةً لنفس المتغيّر، بينما قواعد
 * الرؤية/النشاط يفرضها المستدعي على المنتج والمتغيّر والوحدة حسب سياقه.
 */
function unitAliasMatches(pattern: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${productUnitBarcodes} AS catalog_search_alias
    WHERE catalog_search_alias.productUnitId = ${productUnits.id}
      AND lower(coalesce(catalog_search_alias.barcode, '')) LIKE ${pattern} ESCAPE '!'
  )`;
}

/**
 * شرط البحث الذكي: الاستعلام يُقطَّع كلماتٍ مُطبَّعة، وكل كلمة يجب أن تَرِد في
 * **أيّ** عمود (اسم/SKU/متغيّر/باركود) — والكلمات تُجمَع بـAND ⇒
 * «قلم ازرق» يجد «قلم جاف أزرق» مهما تباعدت الكلمات. يعيد null لاستعلام فارغ.
 */
function buildCatalogSearchWhere(query: string | undefined): SQL | null {
  const tokens = tokenizeSearchQuery(query ?? "");
  if (!tokens.length) return null;
  const cols = searchableCols();
  const perToken = tokens.map((t) => {
    const pat = `%${escLike(t)}%`;
    return or(...cols.map((c) => sql`${c} LIKE ${pat} ESCAPE '!'`), unitAliasMatches(pat));
  });
  return and(...perToken) ?? null;
}

/**
 * شرط البحث على حبيبة المتغيّر، لا الوحدة. هذه هي الواجهة الحاكمة لكل منتقي مخزون
 * يعيد صفاً واحداً لكل `productVariant` (الجرد/التسوية):
 *
 * - الاسم وSKU واسم المتغيّر تُطبَّع بنفس عقد بحث الكتالوج.
 * - أي باركود أساسي أو بديل لأي وحدة يعيد المتغيّر المالك.
 * - EXISTS يحفظ صفاً واحداً لكل متغيّر مهما تعددت وحداته وبدائله، فلا ينكسر limit/offset.
 */
function buildVariantCatalogSearchWhere(query: string | undefined): SQL | null {
  const tokens = tokenizeSearchQuery(query ?? "");
  if (!tokens.length) return null;

  const variantCols = [
    sql`coalesce(${products.searchNorm}, '')`,
    foldedCol(productVariants.sku),
    foldedCol(productVariants.variantName),
  ];
  const perToken = tokens.map((token) => {
    const pattern = `%${escLike(token)}%`;
    return or(
      ...variantCols.map((col) => sql`${col} LIKE ${pattern} ESCAPE '!'`),
      sql`EXISTS (
        SELECT 1
        FROM ${productUnits} AS variant_search_unit
        WHERE variant_search_unit.variantId = ${productVariants.id}
          AND lower(coalesce(variant_search_unit.barcode, '')) LIKE ${pattern} ESCAPE '!'
      )`,
      sql`EXISTS (
        SELECT 1
        FROM ${productUnitBarcodes} AS variant_search_alias
        INNER JOIN ${productUnits} AS variant_search_alias_unit
          ON variant_search_alias_unit.id = variant_search_alias.productUnitId
        WHERE variant_search_alias_unit.variantId = ${productVariants.id}
          AND lower(coalesce(variant_search_alias.barcode, '')) LIKE ${pattern} ESCAPE '!'
      )`,
    );
  });
  const fuzzyMatch = and(...perToken);
  if (!fuzzyMatch) return null;

  // إن كان نص البحث الكامل باركوداً مسجّلاً بالضبط، نحصر النتيجة في مالكه ولا نسمح
  // لمطابقة LIKE عَرَضيّة في اسم/SKU آخر أن تسبقه بسبب order/limit. الشكل الخام له
  // أولوية مطلقة؛ لا نرجع إلى الشكل المطبّع إلا عند غياب الخام عالمياً، حتى لا يصبح
  // باركودان صالحان لمالكين مختلفين نتيجة واحدة بعد تطبيع الأرقام/المسافات.
  const rawExactCode = (query ?? "").trim().toLowerCase();
  const normalizedExactCode = normalizeSearchText(query ?? "");
  const exactForVariant = (code: string) => sql`(
    EXISTS (
      SELECT 1
      FROM ${productUnits} AS variant_exact_unit
      WHERE variant_exact_unit.variantId = ${productVariants.id}
        AND BINARY lower(coalesce(variant_exact_unit.barcode, '')) = BINARY ${code}
    )
    OR EXISTS (
      SELECT 1
      FROM ${productUnitBarcodes} AS variant_exact_alias
        INNER JOIN ${productUnits} AS variant_exact_alias_unit
          ON variant_exact_alias_unit.id = variant_exact_alias.productUnitId
      WHERE variant_exact_alias_unit.variantId = ${productVariants.id}
        AND BINARY lower(coalesce(variant_exact_alias.barcode, '')) = BINARY ${code}
    )
  )`;
  const anyExactBarcode = (code: string) => sql`(
    EXISTS (
      SELECT 1 FROM ${productUnits} AS any_exact_unit
      WHERE BINARY lower(coalesce(any_exact_unit.barcode, '')) = BINARY ${code}
    )
    OR EXISTS (
      SELECT 1 FROM ${productUnitBarcodes} AS any_exact_alias
      WHERE BINARY lower(coalesce(any_exact_alias.barcode, '')) = BINARY ${code}
    )
  )`;
  const rawForVariant = exactForVariant(rawExactCode);
  const anyRawBarcode = anyExactBarcode(rawExactCode);
  if (normalizedExactCode === rawExactCode) {
    return sql`(${rawForVariant} OR (NOT ${anyRawBarcode} AND ${fuzzyMatch}))`;
  }

  const normalizedForVariant = exactForVariant(normalizedExactCode);
  const anyNormalizedBarcode = anyExactBarcode(normalizedExactCode);
  return sql`(
    ${rawForVariant}
    OR (NOT ${anyRawBarcode} AND ${normalizedForVariant})
    OR (NOT ${anyRawBarcode} AND NOT ${anyNormalizedBarcode} AND ${fuzzyMatch})
  )`;
}

/**
 * ترتيب بالملاءمة: تطابق تام (باركود/SKU) أولاً، ثم اسم يبدأ بالاستعلام،
 * ثم الأقرب لبداية الاسم، ثم أبجدياً — بدل «الأحدث أولاً» الذي يدفن المطلوب.
 */
function buildCatalogSearchOrder(query: string | undefined): SQL[] {
  const tokens = tokenizeSearchQuery(query ?? "");
  if (!tokens.length) return [];
  const whole = tokens.join(" ");
  const wholePrefix = `${escLike(whole)}%`;
  // D2 (٣٠/٦): products.searchNorm المُولَّد ⇒ LIKE 'prefix%' يَستفيد من فهرس B-tree O(log n).
  const name = sql`coalesce(${products.searchNorm}, '')`;
  const rank = sql`case
    when ${foldedCol(productUnits.barcode)} = ${whole} then 0
    when ${foldedCol(productVariants.sku)} = ${whole} then 1
    when ${name} LIKE ${wholePrefix} ESCAPE '!' then 2
    else 3
  end`;
  return [rank, sql`instr(${name}, ${tokens[0]})`, asc(products.name)];
}


// تصدير داخلي للحزمة فقط (يستهلكه pos/purchase/adminList/productExtras) — لا يُعاد تصديره من
// البرميل catalogService.ts.
export {
  ordinaryCatalogProduct as notPrintService,
  activeOnly,
  posVisibility,
  buildCatalogSearchWhere,
  buildVariantCatalogSearchWhere,
  buildCatalogSearchOrder,
};
