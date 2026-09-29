import { describe, expect, it } from "vitest";
import {
  ARABIC_NORMALIZATION_PAIRS,
  normalizeArabicSearch,
  tokenizeSearchTerms,
  scoreStorefrontSearchRelevance,
  getStorefrontSearchSuggestions,
} from "./storefrontSearchNormalize";

describe("normalizeArabicSearch", () => {
  it("folds alef variants to bare alef so hamza-agnostic queries hit hamza-carrying products", () => {
    expect(normalizeArabicSearch("أوراق")).toBe("اوراق");
    expect(normalizeArabicSearch("إوراق")).toBe("اوراق");
    expect(normalizeArabicSearch("آوراق")).toBe("اوراق");
    expect(normalizeArabicSearch("ٱوراق")).toBe("اوراق");
    expect(normalizeArabicSearch("اوراق")).toBe("اوراق"); // idempotent
  });

  it("folds taa marbuta (ة) to haa (ه) — common variant in casual typing", () => {
    expect(normalizeArabicSearch("علبة")).toBe("علبه");
    expect(normalizeArabicSearch("علبه")).toBe("علبه");
  });

  it("folds alif maqsura (ى) to yaa (ي)", () => {
    expect(normalizeArabicSearch("مستشفى")).toBe("مستشفي");
    expect(normalizeArabicSearch("احياء")).toBe("احياء");
    expect(normalizeArabicSearch("أولى")).toBe("اولي");
  });

  it("normalizes Eastern Arabic and Persian digits to Western digits (0-9)", () => {
    expect(normalizeArabicSearch("دفتر ١٠٠ ورقة")).toBe("دفتر 100 ورقه");
    expect(normalizeArabicSearch("قلم 0.7 ملم")).toBe("قلم 0.7 ملم");
    expect(normalizeArabicSearch("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeArabicSearch("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("strips tashkeel / diacritics from Arabic input", () => {
    expect(normalizeArabicSearch("دَفْتَرٌ")).toBe("دفتر");
    expect(normalizeArabicSearch("كِتَابُ الأحْيَاءِ")).toBe("كتاب الاحياء");
  });

  it("collapses whitespace and trims — normalized term is safe for LIKE pattern with escLike", () => {
    expect(normalizeArabicSearch("  دفتر   احضار  ")).toBe("دفتر احضار");
    expect(normalizeArabicSearch("\tقلم\nازرق")).toBe("قلم ازرق");
  });

  it("is idempotent — normalizing an already-normalized value returns it unchanged", () => {
    const original = "دفتر احضار 100";
    expect(normalizeArabicSearch(normalizeArabicSearch(original))).toBe(original);
  });

  it("preserves non-Arabic characters (Latin, digits, punctuation)", () => {
    expect(normalizeArabicSearch("Notebook A5")).toBe("notebook a5");
    expect(normalizeArabicSearch("قلم Pilot G-2")).toBe("قلم pilot g-2");
  });

  it("handles empty and whitespace-only inputs", () => {
    expect(normalizeArabicSearch("")).toBe("");
    expect(normalizeArabicSearch("   ")).toBe("");
  });

  it("ARABIC_NORMALIZATION_PAIRS is stable — server SQL builder relies on this exact order/set", () => {
    expect(ARABIC_NORMALIZATION_PAIRS).toEqual([
      ["أ", "ا"],
      ["إ", "ا"],
      ["آ", "ا"],
      ["ٱ", "ا"],
      ["ة", "ه"],
      ["ى", "ي"],
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
    ]);
  });
});

describe("tokenizeSearchTerms", () => {
  it("splits search text into normalized tokens", () => {
    expect(tokenizeSearchTerms("احياء متميزين")).toEqual(["احياء", "متميزين"]);
    expect(tokenizeSearchTerms("  كتاب   أحياء  اول   متوسط  ")).toEqual(["كتاب", "احياء", "اول", "متوسط"]);
  });

  it("normalizes digits within tokens", () => {
    expect(tokenizeSearchTerms("دفتر ١٠٠")).toEqual(["دفتر", "100"]);
  });

  it("returns empty array for empty or whitespace-only inputs", () => {
    expect(tokenizeSearchTerms("")).toEqual([]);
    expect(tokenizeSearchTerms("   ")).toEqual([]);
  });

  it("handles punctuation and punctuation delimiters cleanly", () => {
    expect(tokenizeSearchTerms("احياء - متميزين")).toEqual(["احياء", "متميزين"]);
    expect(tokenizeSearchTerms("كتاب (أحياء)، متميزين!")).toEqual(["كتاب", "احياء", "متميزين"]);
    expect(tokenizeSearchTerms("قلم 0.7 ملم")).toEqual(["قلم", "0.7", "ملم"]);
    expect(tokenizeSearchTerms("---")).toEqual([]);
  });
});

describe("scoreStorefrontSearchRelevance", () => {
  const target = (productName: string, storeTitle: string | null = null, brand: string | null = null) => ({
    productName,
    storeTitle,
    brand,
  });

  it("ranks exact match higher than prefix match, and prefix match higher than infix match", () => {
    const exact = target("دفتر");
    const prefix = target("دفتر سلك A5");
    const infix = target("قلم مع دفتر ملاحظات");

    const query = "دفتر";
    const scoreExact = scoreStorefrontSearchRelevance(exact, query);
    const scorePrefix = scoreStorefrontSearchRelevance(prefix, query);
    const scoreInfix = scoreStorefrontSearchRelevance(infix, query);

    expect(scoreExact).toBeGreaterThan(scorePrefix);
    expect(scorePrefix).toBeGreaterThan(scoreInfix);
  });

  it("rewards matching across brand and product name", () => {
    const item = target("قلم حبر جاف", null, "Stabilo");
    const scoreBrandName = scoreStorefrontSearchRelevance(item, "stabilo قلم");
    expect(scoreBrandName).toBeGreaterThan(50);
  });

  it("accurately matches tokens as full words even when title contains punctuation like parentheses and commas", () => {
    const punctuatedItem = target("دفتر سلك (100 ورقة)");
    const unpunctuatedItem = target("دفتر سلك 100 ورقة");
    const scoreP = scoreStorefrontSearchRelevance(punctuatedItem, "100");
    const scoreU = scoreStorefrontSearchRelevance(unpunctuatedItem, "100");

    // كلا المنتجين يجب أن ينالا نفس نقاط تطابق الكلمة الكاملة (Word match) بغض النظر عن الأقواس
    expect(scoreP).toBe(scoreU);
  });

  it("returns 0 for empty search queries", () => {
    expect(scoreStorefrontSearchRelevance(target("دفتر"), "")).toBe(0);
    expect(scoreStorefrontSearchRelevance(target("دفتر"), "   ")).toBe(0);
  });
});

describe("getStorefrontSearchSuggestions shared implementation", () => {
  const p = (productId: number, productName: string, brand: string | null = null, inStock = true) => ({
    productId,
    productName,
    brand,
    inStock,
  });

  it("matches multi-word tokens in any order", () => {
    const items = [
      p(1, "كتاب احياء اول متوسط متميزين"),
      p(2, "كتاب كيمياء اول متوسط"),
      p(3, "دفتر رسم متميزين"),
    ];

    expect(getStorefrontSearchSuggestions(items, "احياء متميزين").map((it) => it.productId)).toEqual([1]);
    expect(getStorefrontSearchSuggestions(items, "متميزين احياء").map((it) => it.productId)).toEqual([1]);
    expect(getStorefrontSearchSuggestions(items, "متميزين اول").map((it) => it.productId)).toEqual([1]);
  });

  it("matches numbers seamlessly between Eastern Arabic and Western digits", () => {
    const items = [
      p(1, "دفتر 100 ورقة"),
      p(2, "دفتر ٢٠٠ ورقة"),
    ];

    expect(getStorefrontSearchSuggestions(items, "دفتر ١٠٠").map((it) => it.productId)).toEqual([1]);
    expect(getStorefrontSearchSuggestions(items, "دفتر 200").map((it) => it.productId)).toEqual([2]);
    expect(getStorefrontSearchSuggestions(items, "100").map((it) => it.productId)).toEqual([1]);
    expect(getStorefrontSearchSuggestions(items, "٢٠٠").map((it) => it.productId)).toEqual([2]);
  });

  it("normalizes alif maqsura and yaa", () => {
    const items = [
      p(1, "مستشفى الأمل"),
      p(2, "مكتبة الشرق"),
    ];

    expect(getStorefrontSearchSuggestions(items, "مستشفي").map((it) => it.productId)).toEqual([1]);
  });

  it("prioritizes in-stock products over out-of-stock products", () => {
    const items = [
      p(1, "دفتر فاخر متميز", null, false), // out of stock
      p(2, "دفتر عادي متميز", null, true),  // in stock
    ];

    expect(getStorefrontSearchSuggestions(items, "دفتر متميز").map((it) => it.productId)).toEqual([2, 1]);
  });

  it("caps tokens to MAX_STOREFRONT_SEARCH_TOKENS for suggestions consistency", () => {
    const items = [
      p(1, "ت1 ت2 ت3 ت4 ت5 ت6 ت7 ت8"),
    ];
    // بحث بـ 9 كلمات، أول 8 كلمات مطابقة بينما الكلمة 9 ليست في المنتج
    const query = "ت1 ت2 ت3 ت4 ت5 ت6 ت7 ت8 ت9_غير_موجودة";
    // لأن الاقتراحات مقيدة بـ 8 كلمات متطابقة مع الخادم، تطابق أول 8 كلمات
    expect(getStorefrontSearchSuggestions(items, query).map((it) => it.productId)).toEqual([1]);
  });
});
