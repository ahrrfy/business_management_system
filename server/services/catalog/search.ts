// أدوات البحث والرؤية المشتركة (POS/الشراء/الإدارة) — لا تُصدَّر من نقطة الدخول العامة.
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { productUnits, productVariants, products } from "../../../drizzle/schema";
import { ARABIC_FOLD_PAIRS, tokenizeSearchQuery } from "../../../shared/searchNormalize";
import { escLike } from "../../lib/sqlLike";
import { PRINT_SERVICE_TYPE } from "../printSaleService";

// خدمات الطباعة (productType=PRINT_SERVICE) مُستثناة من كاشير الباركود/الشراء: لا مخزون لها،
// وتُباع عبر شاشة «نقطة بيع الطباعة» فقط. (NULL = منتج عادي ⇒ يبقى ظاهراً.)
const notPrintService = sql`(${products.productType} IS NULL OR ${products.productType} <> ${PRINT_SERVICE_TYPE})`;
const activeOnly = and(
  eq(products.isActive, true),
  eq(productVariants.isActive, true),
  eq(productUnits.isActive, true),
  notPrintService
);

// رؤية كاشير الاستقبال: كالعادي + خدمات الطباعة المفعَّل عليها showInReception (تُباع عبر createPrintSale).
const receptionVisible = sql`(${products.productType} IS NULL OR ${products.productType} <> ${PRINT_SERVICE_TYPE} OR ${products.showInReception} = TRUE)`;
function posVisibility(includeReceptionServices: boolean) {
  return and(
    eq(products.isActive, true),
    eq(productVariants.isActive, true),
    eq(productUnits.isActive, true),
    includeReceptionServices ? receptionVisible : notPrintService,
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
    return or(...cols.map((c) => sql`${c} LIKE ${pat} ESCAPE '!'`));
  });
  return and(...perToken) ?? null;
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
export { notPrintService, activeOnly, posVisibility, buildCatalogSearchWhere, buildCatalogSearchOrder };
