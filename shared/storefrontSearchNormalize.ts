// تطبيعُ البحث في المتجر — مصدرٌ واحدٌ يشترك فيه العميل (تصفيةٌ محلّية للاقتراحات) والخادم
// (LIKE على أعمدة الكتالوج). الفصلُ بينهما كان جذر عطبٍ حقيقيٍّ أمسكه Codex على #904:
// الاقتراحات تظهر لحظياً لأنّها تُصفّى محلياً بتطبيعٍ عربيّ + storeTitle، ثمّ تختفي حين
// يستبدل الخادم صفحات الكتالوج بنتائج LIKE خامّ على `products.name`/brand/barcode بلا
// تطبيعٍ ولا storeTitle.
//
// المفتاح: القاعدة الواحدة تعمل هنا (JS للعميل + للخادم) وتُبنى منها عبارة SQL موازية (REPLACE
// متسلسل على العمود) بنفس التحويلات بالضبط — فإن تفوّق البحث على الاقتراح، تفوّق حقاً؛
// وإن قصر، قصر معه بلا سراب.

/** أزواج التطبيع العربيّ المُطبَّقة على القيمة والاستعلام معاً:
 *  - الألفات (أ/إ/آ/ٱ ← ا)
 *  - التاء المربوطة (ة ← ه)
 *  - الألف المقصورة (ى ← ي)
 *  - الأرقام المشرقية والمغربية (٠-٩ مع 0-9) بالإضافة للأرقام الفارسية/الأردية الشائعة. */
export const ARABIC_NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  // الألفات
  ["أ", "ا"],
  ["إ", "ا"],
  ["آ", "ا"],
  ["ٱ", "ا"],
  // التاء المربوطة
  ["ة", "ه"],
  // الألف المقصورة إلى ياء
  ["ى", "ي"],
  // الأرقام المشرقية (الهندية/العربية المشرقية) إلى أرقام قياسية
  ["٠", "0"],
  ["١", "1"],
  ["٢", "2"],
  ["٣", "3"],
  ["٤", "4"],
  ["٥", "5"],
  ["٦", "6"],
  ["٧", "7"],
  ["٨", "8"],
  ["٩", "9"],
  // الأرقام الفارسية/الأردية الشائعة على بعض الأجهزة
  ["۰", "0"],
  ["۱", "1"],
  ["۲", "2"],
  ["۳", "3"],
  ["۴", "4"],
  ["۵", "5"],
  ["۶", "6"],
  ["۷", "7"],
  ["۸", "8"],
  ["۹", "9"],
];

/** يُطبّع نصّاً لبحث المتجر: أحرفٌ صغيرة (بحسب `ar`) + توحيدُ الألفات والتاء المربوطة والألف المقصورة والأرقام + طيّ
 *  فراغاتٍ متعدّدة. النتيجة قابلةٌ للنقلِ حرفياً إلى `LIKE`ٍ خادميٍّ حين يُطبَّق REPLACE
 *  المُتَتَابع نفسه على العمود. */
export function normalizeArabicSearch(value: string): string {
  if (!value) return "";
  let result = value.toLocaleLowerCase("ar");
  for (const [from, to] of ARABIC_NORMALIZATION_PAIRS) {
    result = result.split(from).join(to);
  }
  // إزالة حركات التشكيل (الفتحة، الضمة، الكسرة، التنوين، الشدة، السكون) إن وجدت في المدخلات
  result = result.replace(/[\u064B-\u065F\u0670]/g, "");
  return result.replace(/\s+/g, " ").trim();
}

/**
 * يقسم نص البحث إلى كلمات مستقلة (Tokens) مطبّعة، لاستعمالها في البحث المتعدد بأي ترتيب.
 * يتجاهل الفراغات المكررة والرموز الفارغة.
 */
const WORD_CHAR_REGEX = new RegExp("[\\p{L}\\p{N}]", "u");
const TRIM_PUNCT_REGEX = new RegExp("^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$", "gu");

export const MAX_STOREFRONT_SEARCH_TOKENS = 8;

export function tokenizeSearchTerms(value: string): string[] {
  const normalized = normalizeArabicSearch(value);
  if (!normalized) return [];
  return normalized
    .split(/[\s،,;؛:!؟?()\[\]{}"'«»]+/)
    .map((t) => t.replace(TRIM_PUNCT_REGEX, ""))
    .filter((t) => t.length > 0 && WORD_CHAR_REGEX.test(t));
}


export interface SearchRelevanceTarget {
  productName: string;
  storeTitle?: string | null;
  brand?: string | null;
}

/**
 * حساب درجة الملاءمة (Relevance Score) لمنتج بالنسبة لنص بحث:
 * 1. التطابق الدقيق والكامل لعنوان المنتج أو اسم المتجر مع عبارة البحث (الأولوية القصوى).
 * 2. تطابق بداية عنوان المنتج (Prefix match) مع عبارة البحث.
 * 3. احتواء العنوان على عبارة البحث كجملة متصلة (Substring match).
 * 4. تطابق الكلمات المستقلة (Tokens) كبدايات كلمات (Word prefix) أو كلمات كاملة.
 * 5. التطابق في الماركة التجارية.
 * 6. معامل كفاءة نسبة الطول (العناوين الأقصر والأكثر تركيزاً تنال تفضيلاً طفيفاً).
 */
export function scoreStorefrontSearchRelevance(
  target: SearchRelevanceTarget,
  rawSearch: string,
): number {
  const normSearch = normalizeArabicSearch(rawSearch);
  if (!normSearch) return 0;
  const tokens = tokenizeSearchTerms(rawSearch).slice(0, MAX_STOREFRONT_SEARCH_TOKENS);
  if (tokens.length === 0) return 0;

  const normName = normalizeArabicSearch(target.productName);
  const normStoreTitle = target.storeTitle ? normalizeArabicSearch(target.storeTitle) : "";
  const normBrand = target.brand ? normalizeArabicSearch(target.brand) : "";
  const primaryTitle = normStoreTitle || normName;

  let score = 0;

  // 1. التطابق الكامل الدقيق
  if (primaryTitle === normSearch) {
    score += 1000;
  } else if (normName === normSearch) {
    score += 900;
  } else if (normBrand === normSearch) {
    score += 700;
  }
  // 2. تطابق البداية (Prefix match)
  else if (primaryTitle.startsWith(normSearch)) {
    score += 500;
  } else if (normName.startsWith(normSearch)) {
    score += 450;
  } else if (normBrand.startsWith(normSearch)) {
    score += 350;
  }
  // 3. تطابق العبارة المتصلة داخل النص (Infix match)
  else if (primaryTitle.includes(normSearch)) {
    score += 300;
  } else if (normName.includes(normSearch)) {
    score += 250;
  } else if (normBrand.includes(normSearch)) {
    score += 200;
  }

  // 4. مطابقة الكلمات المفردة (Tokens) — استخدام tokenizeSearchTerms يجرّد علامات الترقيم من الكلمات
  const titleWords = tokenizeSearchTerms(primaryTitle);
  const nameWords = normName ? tokenizeSearchTerms(normName) : [];
  const brandWords = normBrand ? tokenizeSearchTerms(normBrand) : [];

  for (const token of tokens) {
    if (titleWords.some((w) => w === token) || nameWords.some((w) => w === token)) {
      score += 60;
    } else if (titleWords.some((w) => w.startsWith(token)) || nameWords.some((w) => w.startsWith(token))) {
      score += 40;
    } else if (primaryTitle.includes(token) || normName.includes(token)) {
      score += 20;
    }

    if (brandWords.some((w) => w === token)) {
      score += 30;
    } else if (brandWords.some((w) => w.startsWith(token))) {
      score += 20;
    } else if (normBrand.includes(token)) {
      score += 10;
    }
  }

  // 5. معامل نسبة التغطية (كلما كان العنوان أقصر وأقرب لطول البحث زادت الملاءمة)
  const len = Math.max(primaryTitle.length, 1);
  const ratio = Math.min(normSearch.length / len, 1);
  score += Math.round(ratio * 30);

  return score;
}

/**
 * اقتراحات البحث للمتجر:
 * تطابق متعدد الكلمات (Tokens) بأي ترتيب مع تطبيع الأرقام والحروف والبحث الجزئي.
 * ترتيب النتائج بحسب درجة الملاءمة مع إعطاء الأولوية للمنتجات المتوفرة.
 */
export function getStorefrontSearchSuggestions<
  T extends { productName: string; brand?: string | null; storeTitle?: string | null; inStock?: boolean }
>(products: T[], rawSearch: string): T[] {
  const normSearch = normalizeArabicSearch(rawSearch);
  if (normSearch.length < 2) return [];
  const tokens = tokenizeSearchTerms(rawSearch).slice(0, MAX_STOREFRONT_SEARCH_TOKENS);
  if (tokens.length === 0) return [];

  const matched: Array<{ product: T; originalIndex: number; score: number; inStock: number }> = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const text = normalizeArabicSearch(
      `${product.productName} ${product.storeTitle ?? ""} ${product.brand ?? ""}`
    );
    if (tokens.every((token) => text.includes(token))) {
      matched.push({
        product,
        originalIndex: i,
        score: scoreStorefrontSearchRelevance(product, rawSearch),
        inStock: product.inStock !== false ? 1 : 0,
      });
    }
  }

  matched.sort((a, b) =>
    b.inStock - a.inStock
    || b.score - a.score
    || a.originalIndex - b.originalIndex
  );

  return matched.slice(0, 6).map((item) => item.product);
}
