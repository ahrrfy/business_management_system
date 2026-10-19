// Shared normalization and matching for the published catalog, full-catalog suggestions and UI helpers.
// Keep name/brand/category text and customer input on the same Arabic/digit/token contract.
// Barcode ownership is resolved separately before this text search.

/** أزواج التطبيع العربيّ المُطبَّقة على القيمة والاستعلام معاً:
 *  - الألفات (أ/إ/آ/ٱ ← ا)
 *  - التاء المربوطة (ة ← ه)
 *  - الألف المقصورة (ى ← ي)
 *  - الأرقام المشرقية والمغربية (٠-٩ مع 0-9) بالإضافة للأرقام الفارسية/الأردية الشائعة. */
export const ARABIC_NORMALIZATION_PAIRS: ReadonlyArray<
  readonly [string, string]
> = [
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

const NORMALIZATION_MAP = new Map(ARABIC_NORMALIZATION_PAIRS);
const NORMALIZATION_REGEX = new RegExp(
  `[${ARABIC_NORMALIZATION_PAIRS.map(([from]) => from).join("")}]`,
  "g",
);

/** Arabic letters/digits, lower case, diacritics and repeated whitespace share one normalization. */
export function normalizeArabicSearch(value: string): string {
  if (!value) return "";
  let result = value
    .toLocaleLowerCase("ar")
    .replace(
      NORMALIZATION_REGEX,
      (character) => NORMALIZATION_MAP.get(character)!,
    );
  // إزالة حركات التشكيل (الفتحة، الضمة، الكسرة، التنوين، الشدة، السكون) إن وجدت في المدخلات
  result = result.replace(/[\u064B-\u065F\u0670]/g, "");
  return result.replace(/\s+/g, " ").trim();
}

/**
 * يقسم نص البحث إلى كلمات مستقلة (Tokens) مطبّعة، لاستعمالها في البحث المتعدد بأي ترتيب.
 * يتجاهل الفراغات المكررة والرموز الفارغة.
 */
const WORD_CHAR_REGEX = new RegExp("[\\p{L}\\p{N}]", "u");
const TRIM_PUNCT_REGEX = new RegExp(
  "^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$",
  "gu",
);

export const MAX_STOREFRONT_SEARCH_TOKENS = 8;

export function tokenizeSearchTerms(value: string): string[] {
  return tokenizeNormalizedSearchTerms(normalizeArabicSearch(value));
}

function tokenizeNormalizedSearchTerms(normalized: string): string[] {
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
  barcode?: string | null;
  category?: string | null;
  /** Precomputed only in the short-lived server index. */
  searchText?: string;
  searchWords?: string[];
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
  const tokens = tokenizeNormalizedSearchTerms(normSearch).slice(
    0,
    MAX_STOREFRONT_SEARCH_TOKENS,
  );
  if (tokens.length === 0) return 0;
  return scorePreparedSearchRelevance(target, normSearch, tokens);
}

function scorePreparedSearchRelevance(
  target: SearchRelevanceTarget,
  normSearch: string,
  tokens: readonly string[],
): number {
  const normName = normalizeArabicSearch(target.productName);
  const normStoreTitle = target.storeTitle
    ? normalizeArabicSearch(target.storeTitle)
    : "";
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
  const titleWords = tokenizeNormalizedSearchTerms(primaryTitle);
  const nameWords = normName ? tokenizeNormalizedSearchTerms(normName) : [];
  const brandWords = normBrand ? tokenizeNormalizedSearchTerms(normBrand) : [];

  for (const token of tokens) {
    if (
      titleWords.some((w) => w === token) ||
      nameWords.some((w) => w === token)
    ) {
      score += 60;
    } else if (
      titleWords.some((w) => w.startsWith(token)) ||
      nameWords.some((w) => w.startsWith(token))
    ) {
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

/** Small domain vocabulary: do not equate a generic marker with a highlighter. */
const SEARCH_SYNONYMS = [
  ["ملزمة", "ملازم"],
  ["دفتر", "دفاتر"],
  ["قلم", "أقلام"],
  ["كراس", "كراريس", "كراسات"],
  ["هايلايتر", "هايلايت", "قلم تأشير", "قلم تاشير", "highlighter"],
  ["انكليزي", "انجليزي", "إنكليزي", "إنجليزي", "english"],
  ["ستيكر", "ستيكرات", "ملصق", "ملصقات"],
] as const;
const APPROXIMATE_WORD_REGEX = new RegExp("^[\\p{L}]{4,}$", "u");
const synonymGroups = SEARCH_SYNONYMS.map((group) =>
  Array.from(new Set(group.map(normalizeArabicSearch))),
);

export type StorefrontSearchMatch = {
  kind: "DIRECT" | "SYNONYM" | "SIMILAR";
  score: number;
  correction: string | null;
};

export function expandStorefrontSearch(raw: string): string[] {
  const query = tokenizeSearchTerms(raw)
    .slice(0, MAX_STOREFRONT_SEARCH_TOKENS)
    .join(" ");
  if (!query) return [];
  const variants = new Set([query]);
  for (const group of synonymGroups) {
    for (const variant of Array.from(variants)) {
      for (const phrase of group) {
        const padded = ` ${variant} `;
        if (!padded.includes(` ${phrase} `)) continue;
        for (const replacement of group) {
          if (variants.size >= 16) break;
          variants.add(
            padded.replace(` ${phrase} `, ` ${replacement} `).trim(),
          );
        }
      }
    }
  }
  return Array.from(variants);
}

/** At most one insertion/deletion/substitution or adjacent transposition. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length)
    return (
      a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] &&
        a[i + 1] === b[i] &&
        a.slice(i + 2) === b.slice(i + 2))
    );
  return a.length > b.length
    ? a.slice(i + 1) === b.slice(i)
    : a.slice(i) === b.slice(i + 1);
}

export function matchStorefrontSearch(
  target: SearchRelevanceTarget,
  raw: string,
  allowSimilar = false,
): StorefrontSearchMatch | null {
  return createStorefrontSearchMatcher(raw, allowSimilar)(target);
}

export function createStorefrontSearchMatcher(
  raw: string,
  allowSimilar = false,
) {
  const variants = expandStorefrontSearch(raw).map((query) => {
    const terms = tokenizeSearchTerms(query);
    return {
      terms,
      normalized: normalizeArabicSearch(query),
      scoreTerms: terms.slice(0, MAX_STOREFRONT_SEARCH_TOKENS),
    };
  });
  return (target: SearchRelevanceTarget): StorefrontSearchMatch | null => {
    if (!variants.length) return null;
    const text =
      target.searchText ??
      normalizeArabicSearch(
        `${target.productName} ${target.storeTitle ?? ""} ${target.brand ?? ""} ${target.category ?? ""} ${target.barcode ?? ""}`,
      );
    for (let index = 0; index < variants.length; index++) {
      const terms = variants[index].terms;
      if (terms.every((term) => text.includes(term))) {
        return {
          kind: index === 0 ? "DIRECT" : "SYNONYM",
          score:
            (index === 0 ? 10_000 : 5_000) +
            scorePreparedSearchRelevance(
              target,
              variants[index].normalized,
              variants[index].scoreTerms,
            ),
          correction: null,
        };
      }
    }
    if (!allowSimilar) return null;
    // Never approximate digits, model/barcode tokens, short words or more than one token.
    const terms = variants[0].terms;
    const missing = terms.filter((term) => !text.includes(term));
    if (missing.length !== 1 || !APPROXIMATE_WORD_REGEX.test(missing[0]))
      return null;
    const words =
      target.searchWords ??
      tokenizeSearchTerms(
        `${target.storeTitle ?? ""} ${target.productName} ${target.brand ?? ""} ${target.category ?? ""}`,
      );
    const corrected = words.find(
      (word) =>
        APPROXIMATE_WORD_REGEX.test(word) && oneEditApart(missing[0], word),
    );
    if (!corrected) return null;
    const correction = terms
      .map((term) => (term === missing[0] ? corrected : term))
      .join(" ");
    return {
      kind: "SIMILAR",
      score: 1_000 + scoreStorefrontSearchRelevance(target, correction),
      correction,
    };
  };
}

/** Legacy consumers use the same strict/synonym match; approximate hits remain separate. */
export function getStorefrontSearchSuggestions<
  T extends SearchRelevanceTarget & { inStock?: boolean },
>(products: T[], rawSearch: string): T[] {
  if (normalizeArabicSearch(rawSearch).length < 2) return [];
  const match = createStorefrontSearchMatcher(rawSearch);
  return products
    .map((product, index) => ({
      product,
      index,
      match: match(product),
    }))
    .filter((row) => row.match != null)
    .sort(
      (a, b) =>
        b.match!.score - a.match!.score ||
        Number(b.product.inStock !== false) -
          Number(a.product.inStock !== false) ||
        a.index - b.index,
    )
    .slice(0, 6)
    .map((row) => row.product);
}
