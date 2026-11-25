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

  // 4. مطابقة الكلمات المفردة (Tokens) — تفضيل صريح لظهور الكلمة في اسم المنتج نفسه على ظهورها في اسم القسم فقط
  const normCategory = target.category
    ? normalizeArabicSearch(target.category)
    : "";
  const titleWords = tokenizeNormalizedSearchTerms(primaryTitle);
  const nameWords = normName ? tokenizeNormalizedSearchTerms(normName) : [];
  const brandWords = normBrand ? tokenizeNormalizedSearchTerms(normBrand) : [];
  const categoryWords = normCategory
    ? tokenizeNormalizedSearchTerms(normCategory)
    : [];

  for (const token of tokens) {
    if (
      titleWords.some((w) => w === token) ||
      nameWords.some((w) => w === token)
    ) {
      score += 75;
    } else if (
      titleWords.some((w) => w.startsWith(token)) ||
      nameWords.some((w) => w.startsWith(token))
    ) {
      score += 45;
    } else if (primaryTitle.includes(token) || normName.includes(token)) {
      score += 22;
    } else if (categoryWords.some((w) => w === token)) {
      score += 18;
    } else if (categoryWords.some((w) => w.startsWith(token))) {
      score += 10;
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
 * قاموس المتجر للمرادفات والمنطوق العراقي والمفردات المعرّبة (لا يخلط الماركر العام مع الهايلايت).
 * يربط الكلمات البسيطة والدارجة بأسماء الكتالوج الفعلية دون المساس بالباركود أو أرقام الموديلات.
 */
const SEARCH_SYNONYMS = [
  ["ملزمة", "ملازم"],
  ["دفتر", "دفاتر"],
  ["قلم", "أقلام"],
  ["كتاب", "كتب"],
  ["لون", "الوان", "تلوين"],
  ["ورق", "ورقة", "اوراق"],
  ["اداة", "ادوات", "تجهيزات", "مستلزمات"],
  ["علبة", "علب", "سيت", "باكيت", "بكج", "طقم", "مجموعة"],
  ["كراس", "كراريس", "كراسات", "دفتر رسم"],
  ["هايلايتر", "هايلايت", "قلم تأشير", "قلم تاشير", "فسفوري", "قلم فسفوري", "highlighter"],
  ["انكليزي", "انجليزي", "إنكليزي", "إنجليزي", "انقلش", "انكليزيه", "english"],
  ["ستيكر", "ستيكرات", "ملصق", "ملصقات"],
  ["جنطة", "جنط", "حقيبة", "حقائب", "شنطة", "شنط"],
  ["مساحة", "مساحات", "ممحاة", "محاية", "مساح"],
  ["مقطاطة", "مقطاطات", "مبراة", "براية"],
  ["كابسة", "كابسات", "كباسة", "دباسة"],
  ["قراصة", "قراصات", "كلبسة", "ماسكة ورق", "مشبك ورق", "مشابك", "كليب بورد"],
  ["تيب", "لصقة", "سيلوتيب", "شريط لاصق"],
  ["صمغ", "غراء", "لاصق"],
  ["فايل", "فايلات", "ملف", "ملفات", "حافظة ورق", "حافظة"],
  ["حاسبة", "حاسبات", "الة حاسبة", "كاسيو", "casio", "calculator"],
  ["صبورة", "سبورة", "سبورات"],
  ["اكرلك", "اكريليك", "أكريليك", "اكرليك", "acrylic"],
  ["كانفاس", "كنفاس", "لوحة رسم"],
  ["مائية", "مائي", "الوان مائية", "ووتركولر"],
  ["كيميا", "كيمياء"],
  ["فيزيا", "فيزياء"],
  ["احيا", "احياء"],
  ["جغرافيا", "جغرافيه"],
  ["ورق كاشير", "ورق رصيد", "رول حراري", "ورق حراري"],
  ["نوت", "قصاصات", "ستيكي", "ستكي", "ستيكي نوت", "ستكي نوت", "ورق ملاحظات", "ملاحظات", "sticky"],
  ["مصحف", "مصاحف", "قران", "القران الكريم"],
  ["ختم", "اختام"],
  ["هدية", "هدايا", "بوكس هدايا"],
  ["تخرج", "مناسبات", "احتفال"],
  ["فرجال", "هندسية", "هندسة"],
  ["مية", "مائة", "100"],
  ["ميتين", "مائتين", "200"],
  ["شمعة", "شموع"],
  // جسر الماركات العالمية الشائعة في الكتالوج (عربي <-> إنجليزي)
  ["ديلي", "deli"],
  ["كلير", "clear"],
  ["ستدلر", "ستيدلر", "staedtler"],
  ["فابر", "فابر كاستل", "faber", "castell"],
  ["مابد", "مابيد", "maped"],
  ["كانغارو", "كانجارو", "kangaro"],
  ["روكو", "roko"],
  ["بايلوت", "بيلوت", "pilot"],
  ["بانتر", "panter"],
  ["باركر", "parker"],
  ["ام جي", "mg"],
  ["بلوتوث", "bluetooth"],
  ["ايباد", "تابلت", "ipad", "stylus"],
] as const;
const IRAQI_QUERY_FILLER_WORDS = new Set(
  [
    "ابو",
    "ام",
    "مال",
    "مالت",
    "صف",
    "للصف",
    "المرحله",
    "مرحله",
    "قسم",
    "فرع",
    "شريف",
    "كريم",
    "اصلي",
    "اصليه",
    "ماركه",
    "نوعيه",
  ].map(normalizeArabicSearch),
);
const APPROXIMATE_WORD_REGEX = new RegExp("^[\\p{L}]{4,}$", "u");
const PURE_ARABIC_WORD_REGEX = /^[\u0621-\u064A]{3,}$/;
const synonymGroups = SEARCH_SYNONYMS.map((group) =>
  Array.from(new Set(group.map(normalizeArabicSearch))),
);

export type StorefrontSearchMatch = {
  kind: "DIRECT" | "SYNONYM" | "SIMILAR";
  score: number;
  correction: string | null;
};

export function expandStorefrontSearch(raw: string): string[] {
  const baseTokens = tokenizeSearchTerms(raw).slice(0, MAX_STOREFRONT_SEARCH_TOKENS);
  const query = baseTokens.join(" ");
  if (!query) return [];
  const variants = new Set([query]);

  // إزالة كلمات الربط الدارجة في البحث العراقي («دفتر ابو 100» -> «دفتر 100»، «قلم مال صبورة» -> «قلم صبورة»)
  if (baseTokens.length >= 2) {
    const stripped = baseTokens.filter((t) => !IRAQI_QUERY_FILLER_WORDS.has(t));
    if (stripped.length >= 1 && stripped.length < baseTokens.length) {
      variants.add(stripped.join(" "));
    }
  }

  for (const group of synonymGroups) {
    for (const variant of Array.from(variants)) {
      for (const phrase of group) {
        const padded = ` ${variant} `;
        if (!padded.includes(` ${phrase} `)) continue;
        for (const replacement of group) {
          if (variants.size >= 48) break;
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

/** يحسب مسافة التعديل المحدودة بسقف صغير للكلمات الطويلة دون كلفة تربيعية عالية. */
function boundedEditDistance(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
      curr.push(val);
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

/** هيكل صوتي عراقي خفيف يقرّب الحروف المتشابهة مخرجاً وحروف المدّ الداخلية الساقطة في الكتابة السريعة. */
function arabicPhoneticSkeleton(word: string): string {
  const folded = word
    .replace(/ص/g, "س")
    .replace(/ط/g, "ت")
    .replace(/ض/g, "د")
    .replace(/[ذظ]/g, "ز");
  if (folded.length < 5) return folded;
  return folded[0]! + folded.slice(1).replace(/[اوي]/g, "");
}

function isApproximateWordMatch(queryWord: string, candidateWord: string): boolean {
  if (queryWord === candidateWord) return false;
  if (oneEditApart(queryWord, candidateWord)) return true;
  if (
    queryWord.length >= 7 &&
    candidateWord.length >= 7 &&
    queryWord[0] === candidateWord[0] &&
    boundedEditDistance(queryWord, candidateWord, 2) <= 2
  ) {
    return true;
  }
  if (
    PURE_ARABIC_WORD_REGEX.test(queryWord) &&
    PURE_ARABIC_WORD_REGEX.test(candidateWord) &&
    boundedEditDistance(queryWord, candidateWord, 2) <= 2
  ) {
    const skA = arabicPhoneticSkeleton(queryWord);
    const skB = arabicPhoneticSkeleton(candidateWord);
    if (skA.length >= 3 && skA === skB) return true;
  }
  return false;
}

/** يهيّئ نص المطابقة الداخلي بفكّ التصاق الكلمات العربية مع الأرقام/اللاتيني وتوحيد الهمزات المتوسطة والكشيدة. */
function prepareRelaxedMatchText(normalizedText: string): string {
  return normalizedText
    .replace(/\u0640/g, "") // إزالة الكشيدة (التطويل)
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/([\u0621-\u064A])([a-z0-9])/g, "$1 $2")
    .replace(/([a-z0-9])([\u0621-\u064A])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** يستخرج الجذور الصرفية المحتملة للكلمة العربية (حتى جذر ثلاثي >= 3 أحرف) لمطابقة التأنيث والجمع و«ال» التعريف. */
function extractArabicStems(rawWord: string): string[] {
  const w = rawWord.replace(/\u0640/g, "").replace(/ؤ/g, "و").replace(/ئ/g, "ي");
  const stems = new Set<string>([w]);
  if (!PURE_ARABIC_WORD_REGEX.test(w)) return [w];

  // همزة متطرفة ساقطة أو مضافة («كيميا» <-> «كيمياء»، «قرايه» <-> «قراءه»)
  if (w.endsWith("ء") && w.length >= 4) stems.add(w.slice(0, -1));

  const unprefixed = new Set<string>(stems);
  for (const s of Array.from(stems)) {
    if (s.startsWith("ال") && s.length >= 5) unprefixed.add(s.slice(2));
    if ((s.startsWith("وال") || s.startsWith("بال") || s.startsWith("كال")) && s.length >= 6) {
      unprefixed.add(s.slice(3));
    }
    if (s.startsWith("لل") && s.length >= 5) unprefixed.add(s.slice(2));
  }

  const all = new Set<string>(unprefixed);
  // لواحق التأنيث والجمع والتثنية لغير العاقل («مدرسيه» -> «مدرسي»/«مدرس»، «ملونه» -> «ملون»، «خشبيه» -> «خشب»)
  for (const base of Array.from(unprefixed)) {
    for (const suffix of ["ات", "ين", "ون", "ان", "يه", "ها", "ه"]) {
      if (base.endsWith(suffix) && base.length - suffix.length >= 3) {
        all.add(base.slice(0, -suffix.length));
      }
    }
  }
  return Array.from(all);
}

/** يطابق الكلمة مع التسامح ثنائي الاتجاه في «ال» التعريف والتأنيث والجموع والجذور الثلاثية. */
function termMatchesMorphologically(
  term: string,
  relaxedText: string,
  relaxedWords: readonly string[],
): boolean {
  const cleanTerm = prepareRelaxedMatchText(term);
  if (!cleanTerm) return false;
  if (relaxedText.includes(cleanTerm)) return true;
  if (!PURE_ARABIC_WORD_REGEX.test(cleanTerm)) return false;

  const queryStems = extractArabicStems(cleanTerm);
  for (const qStem of queryStems) {
    if (qStem.length < 3) continue;
    for (const targetWord of relaxedWords) {
      if (targetWord.startsWith(qStem)) return true;
      if (targetWord.startsWith("ال") && targetWord.slice(2).startsWith(qStem)) return true;
      // مطابقة عكسية: إذا كان المنتج بصيغة مفرد مذكر («خشب»/«ملون») والزبون كتب مؤنثاً/جمعاً («خشبيه»/«ملونه»)
      if (qStem.length >= 3 && targetWord.length >= 3 && qStem === targetWord) return true;
    }
  }
  return false;
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
    const titleBrandText = normalizeArabicSearch(
      `${target.productName} ${target.storeTitle ?? ""} ${target.brand ?? ""} ${target.barcode ?? ""}`,
    );
    const text =
      target.searchText ??
      normalizeArabicSearch(
        `${target.productName} ${target.storeTitle ?? ""} ${target.brand ?? ""} ${target.category ?? ""} ${target.barcode ?? ""}`,
      );
    // أولوية قصوى للمنتجات التي تطابق كل كلمات البحث (أو مرادفاتها) في اسم المنتج أو الماركة نفسها قبل الاتكاء على اسم القسم العام
    for (let index = 0; index < variants.length; index++) {
      const terms = variants[index].terms;
      if (terms.every((term) => titleBrandText.includes(term))) {
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
    for (let index = 0; index < variants.length; index++) {
      const terms = variants[index].terms;
      if (terms.every((term) => text.includes(term))) {
        return {
          kind: index === 0 ? "DIRECT" : "SYNONYM",
          score:
            (index === 0 ? 4_800 : 4_600) +
            scorePreparedSearchRelevance(
              target,
              variants[index].normalized,
              variants[index].scoreTerms,
            ),
          correction: null,
        };
      }
    }

    const relaxedText = prepareRelaxedMatchText(text);
    const relaxedWords = tokenizeNormalizedSearchTerms(
      prepareRelaxedMatchText(
        normalizeArabicSearch(
          `${target.storeTitle ?? ""} ${target.productName} ${target.brand ?? ""} ${target.category ?? ""}`,
        ),
      ),
    );

    // مطابقة مرنة لـ «ال» التعريف والتأنيث والجموع وفكّ الكلمات الملتصقة بدون المساس بالأرقام أو الرموز
    for (let index = 0; index < variants.length; index++) {
      const terms = variants[index].terms;
      if (terms.every((term) => termMatchesMorphologically(term, relaxedText, relaxedWords))) {
        return {
          kind: "SYNONYM",
          score:
            4_500 +
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
    // 1. تقريب إملائي وصوتي لكلمة واحدة مفقودة (بلا تقريب للأرقام أو السنوات أو أكواد الموديلات)
    for (const candidateVariant of variants) {
      const terms = candidateVariant.terms;
      const missing = terms.filter((term) => !termMatchesMorphologically(term, relaxedText, relaxedWords));
      if (missing.length !== 1 || !APPROXIMATE_WORD_REGEX.test(missing[0])) continue;
      const corrected = relaxedWords.find(
        (word) =>
          APPROXIMATE_WORD_REGEX.test(word) && isApproximateWordMatch(missing[0], word),
      );
      if (!corrected) continue;
      const correction = terms
        .map((term) => (term === missing[0] ? corrected : term))
        .join(" ");
      return {
        kind: "SIMILAR",
        score: 1_000 + scoreStorefrontSearchRelevance(target, correction),
        correction,
      };
    }

    // 2. تقريب الأغلبية (Partial Quorum: تطابق N-1 من الكلمات عند كتابة 3 كلمات فأكثر ووجود كلمة وصفية زائدة)
    // مثال: «ملزمة كيمياء سادس علمي» عندما يكون اسم المنتج «ملزمة سادس كيمياء هاشم الغرباوي» بلا كلمة «علمي».
    const primaryTerms = variants[0].terms;
    if (primaryTerms.length >= 3) {
      const matchedTerms = primaryTerms.filter((term) =>
        termMatchesMorphologically(term, relaxedText, relaxedWords),
      );
      const missingTerms = primaryTerms.filter(
        (term) => !termMatchesMorphologically(term, relaxedText, relaxedWords),
      );
      // لا نسقط أي رقم سنة أو قياس طلبه الزبون صراحةً
      const missingHasDigits = missingTerms.some((t) => /\d/.test(t));
      if (
        !missingHasDigits &&
        missingTerms.length === 1 &&
        matchedTerms.length >= 2
      ) {
        const reducedQuery = matchedTerms.join(" ");
        return {
          kind: "SIMILAR",
          score: 600 + scoreStorefrontSearchRelevance(target, reducedQuery),
          correction: reducedQuery,
        };
      }
    }
    return null;
  };
}

/** يحسب تشابه الثنائيات الحرفية (Dice Bigram Similarity) لالتقاط الكلمات المشابهة نطقاً أو إملاءً. */
function charBigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }
  let overlap = 0;
  for (let j = 0; j < b.length - 1; j += 1) {
    const bg = b.slice(j, j + 2);
    const left = bigramsA.get(bg) ?? 0;
    if (left > 0) {
      overlap += 1;
      bigramsA.set(bg, left - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/**
 * محرك الاسترداد التقريبي العميق لبطاقات المتجر عند عدم وجود تطابق حرفي:
 * - لا يقارب أي رقم سنة أو كود موديل غير موجود فعلياً في المنتج (حماية كاملة من خلط السنوات والموديلات).
 * - يقرّب الكلمات المتعددة الأخطاء والأجزاء الجزئية للأغلبية الدلالية ليعرض أقرب المنتجات المتوفرة فوراً.
 */
export function createClosestRelaxedSearchMatcher(raw: string) {
  const rawTokens = tokenizeSearchTerms(raw).slice(0, MAX_STOREFRONT_SEARCH_TOKENS);
  const numericOrCodeTokens = rawTokens.filter((t) => /\d/.test(t));
  const variants = expandStorefrontSearch(raw)
    .slice(0, 16)
    .map((q) =>
      tokenizeSearchTerms(q)
        .filter((t) => !IRAQI_QUERY_FILLER_WORDS.has(t))
        .slice(0, MAX_STOREFRONT_SEARCH_TOKENS),
    )
    .filter((list) => list.length > 0);

  return (
    target: SearchRelevanceTarget,
  ): { score: number; correction: string | null } | null => {
    if (variants.length === 0) return null;
    const rawCombined =
      target.searchText ??
      normalizeArabicSearch(
        `${target.productName} ${target.storeTitle ?? ""} ${target.brand ?? ""} ${target.category ?? ""} ${target.barcode ?? ""}`,
      );
    const relaxedAll = prepareRelaxedMatchText(rawCombined);

    // حارس الأمان الصارم: أي رقم سنة أو قياس أو كود موديل كتبه الزبون يجب أن يظهر حرفياً في المنتج
    for (const numTok of numericOrCodeTokens) {
      if (!relaxedAll.includes(numTok)) return null;
    }

    const titleRelaxed = prepareRelaxedMatchText(
      normalizeArabicSearch(`${target.storeTitle ?? ""} ${target.productName}`),
    );
    const metaRelaxed = prepareRelaxedMatchText(
      normalizeArabicSearch(`${target.brand ?? ""} ${target.category ?? ""}`),
    );
    const titleWords = tokenizeNormalizedSearchTerms(titleRelaxed);
    const metaWords = tokenizeNormalizedSearchTerms(metaRelaxed);
    const allWords = [...titleWords, ...metaWords];

    let bestScore = 0;
    let bestCorrection: string | null = null;

    for (const terms of variants) {
      let score = 0;
      let matchedCount = 0;
      let titleHitCount = 0;
      let hasApprox = false;
      const correctedTerms: string[] = [];

      for (const term of terms) {
        if (termMatchesMorphologically(term, titleRelaxed, titleWords)) {
          score += 130;
          matchedCount += 1;
          titleHitCount += 1;
          correctedTerms.push(term);
          continue;
        }
        if (termMatchesMorphologically(term, metaRelaxed, metaWords)) {
          score += 65;
          matchedCount += 1;
          correctedTerms.push(term);
          continue;
        }
        if (APPROXIMATE_WORD_REGEX.test(term)) {
          let bestWord: string | null = null;
          let bestWordScore = 0;
          for (const candidate of allWords) {
            if (!APPROXIMATE_WORD_REGEX.test(candidate)) continue;
            const inTitle = titleWords.includes(candidate);
            if (isApproximateWordMatch(term, candidate)) {
              const pts = inTitle ? 95 : 50;
              if (pts > bestWordScore) {
                bestWordScore = pts;
                bestWord = candidate;
              }
            } else if (term.length >= 4 && candidate.length >= 4) {
              const dice = charBigramDice(term, candidate);
              if (dice >= 0.56 && (term[0] === candidate[0] || dice >= 0.66)) {
                const pts = Math.round(dice * (inTitle ? 85 : 45));
                if (pts > bestWordScore) {
                  bestWordScore = pts;
                  bestWord = candidate;
                }
              }
            }
          }
          if (bestWord) {
            score += bestWordScore;
            matchedCount += 1;
            if (titleWords.includes(bestWord)) titleHitCount += 1;
            hasApprox = true;
            correctedTerms.push(bestWord);
          }
        }
      }

      const minRequired =
        terms.length === 1
          ? 1
          : terms.length === 2
            ? 1
            : Math.max(2, Math.ceil(terms.length * 0.5));

      if (matchedCount < minRequired) continue;
      // عند كتابة كلمتين ومطابقة كلمة واحدة فقط، نشترط أن تكون كلمة جوهرية (4 أحرف فأكثر) في اسم المنتج نفسه
      if (terms.length === 2 && matchedCount === 1) {
        const singleMatched = correctedTerms[0] ?? "";
        if (titleHitCount === 0 || singleMatched.length < 4) continue;
      }

      const coverageBonus = Math.round((matchedCount / terms.length) * 220);
      const total = score + coverageBonus + titleHitCount * 25;
      if (total > bestScore) {
        bestScore = total;
        bestCorrection =
          hasApprox || matchedCount < terms.length
            ? correctedTerms.join(" ")
            : null;
      }
    }

    if (bestScore < 120) return null;
    return { score: bestScore, correction: bestCorrection };
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
