import { describe, expect, it } from "vitest";
import {
  ARABIC_NORMALIZATION_PAIRS,
  normalizeArabicSearch,
  tokenizeSearchTerms,
  scoreStorefrontSearchRelevance,
  getStorefrontSearchSuggestions,
  matchStorefrontSearch,
  createStorefrontSearchMatcher,
  createClosestRelaxedSearchMatcher,
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
    expect(normalizeArabicSearch(normalizeArabicSearch(original))).toBe(
      original,
    );
  });

  it("preserves the legacy normalization contract for mixed Unicode and every mapped character", () => {
    // Independent pre-optimization oracle: the order and Unicode case folding are public search semantics.
    const legacy = (value: string) => {
      let normalized = value.toLocaleLowerCase("ar");
      for (const [from, to] of ARABIC_NORMALIZATION_PAIRS) {
        normalized = normalized.split(from).join(to);
      }
      return normalized
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    };
    const alphabet = Array.from(
      "أإآٱةى٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹ دَفْتَرٌ A5 İΣẞ𐐀\u00a0\n\t،;!()🙂",
    );
    let seed = 739;
    for (let sample = 0; sample < 200; sample++) {
      let value = "";
      for (let index = 0; index < 80; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        value += alphabet[seed % alphabet.length];
      }
      expect(normalizeArabicSearch(value)).toBe(legacy(value));
    }
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
    expect(tokenizeSearchTerms("  كتاب   أحياء  اول   متوسط  ")).toEqual([
      "كتاب",
      "احياء",
      "اول",
      "متوسط",
    ]);
  });

  it("normalizes digits within tokens", () => {
    expect(tokenizeSearchTerms("دفتر ١٠٠")).toEqual(["دفتر", "100"]);
  });

  it("returns empty array for empty or whitespace-only inputs", () => {
    expect(tokenizeSearchTerms("")).toEqual([]);
    expect(tokenizeSearchTerms("   ")).toEqual([]);
  });

  it("handles punctuation and punctuation delimiters cleanly", () => {
    expect(tokenizeSearchTerms("احياء - متميزين")).toEqual([
      "احياء",
      "متميزين",
    ]);
    expect(tokenizeSearchTerms("كتاب (أحياء)، متميزين!")).toEqual([
      "كتاب",
      "احياء",
      "متميزين",
    ]);
    expect(tokenizeSearchTerms("قلم 0.7 ملم")).toEqual(["قلم", "0.7", "ملم"]);
    expect(tokenizeSearchTerms("---")).toEqual([]);
  });
});

describe("scoreStorefrontSearchRelevance", () => {
  it("caps relevance at eight tokens while matching every term of an expanded synonym", () => {
    const raw = "هايلايتر احمر فاخر مدرسي جميل جديد صغير قوي";
    const expanded = "قلم تاشير احمر فاخر مدرسي جميل جديد صغير قوي";
    const target = { productName: expanded };
    const match = createStorefrontSearchMatcher(raw);
    expect(match(target)).toEqual({
      kind: "SYNONYM",
      score: 5_000 + scoreStorefrontSearchRelevance(target, expanded),
      correction: null,
    });
    expect(match({ productName: expanded.replace(" قوي", "") })).toBeNull();
  });

  const target = (
    productName: string,
    storeTitle: string | null = null,
    brand: string | null = null,
  ) => ({
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
  const p = (
    productId: number,
    productName: string,
    brand: string | null = null,
    inStock = true,
  ) => ({
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

    expect(
      getStorefrontSearchSuggestions(items, "احياء متميزين").map(
        (it) => it.productId,
      ),
    ).toEqual([1]);
    expect(
      getStorefrontSearchSuggestions(items, "متميزين احياء").map(
        (it) => it.productId,
      ),
    ).toEqual([1]);
    expect(
      getStorefrontSearchSuggestions(items, "متميزين اول").map(
        (it) => it.productId,
      ),
    ).toEqual([1]);
  });

  it("matches numbers seamlessly between Eastern Arabic and Western digits", () => {
    const items = [p(1, "دفتر 100 ورقة"), p(2, "دفتر ٢٠٠ ورقة")];

    expect(
      getStorefrontSearchSuggestions(items, "دفتر ١٠٠").map(
        (it) => it.productId,
      ),
    ).toEqual([1]);
    expect(
      getStorefrontSearchSuggestions(items, "دفتر 200").map(
        (it) => it.productId,
      ),
    ).toEqual([2]);
    expect(
      getStorefrontSearchSuggestions(items, "100").map((it) => it.productId),
    ).toEqual([1]);
    expect(
      getStorefrontSearchSuggestions(items, "٢٠٠").map((it) => it.productId),
    ).toEqual([2]);
  });

  it("normalizes alif maqsura and yaa", () => {
    const items = [p(1, "مستشفى الأمل"), p(2, "مكتبة الشرق")];

    expect(
      getStorefrontSearchSuggestions(items, "مستشفي").map((it) => it.productId),
    ).toEqual([1]);
  });

  it("prioritizes in-stock products over out-of-stock products", () => {
    const items = [
      p(1, "دفتر فاخر متميز", null, false), // out of stock
      p(2, "دفتر عادي متميز", null, true), // in stock
    ];

    expect(
      getStorefrontSearchSuggestions(items, "دفتر متميز").map(
        (it) => it.productId,
      ),
    ).toEqual([2, 1]);
  });

  it("caps tokens to MAX_STOREFRONT_SEARCH_TOKENS for suggestions consistency", () => {
    const items = [p(1, "ت1 ت2 ت3 ت4 ت5 ت6 ت7 ت8")];
    // بحث بـ 9 كلمات، أول 8 كلمات مطابقة بينما الكلمة 9 ليست في المنتج
    const query = "ت1 ت2 ت3 ت4 ت5 ت6 ت7 ت8 ت9_غير_موجودة";
    // لأن الاقتراحات مقيدة بـ 8 كلمات متطابقة مع الخادم، تطابق أول 8 كلمات
    expect(
      getStorefrontSearchSuggestions(items, query).map((it) => it.productId),
    ).toEqual([1]);
  });
});

describe("simple customer search keys", () => {
  const workbook = { productName: "ملزمة ثالث بكر سامي انكليزي 2027" };
  it("finds a two-letter prefix, casual Arabic spelling and reversed tokens", () => {
    for (const query of [
      "مل",
      "ملزمه",
      "انكليزي ثالث",
      "ثالث انكليزي",
      "ملازم ثالث",
      "ملزمة ٢٠٢٧",
    ]) {
      expect(matchStorefrontSearch(workbook, query), query).not.toBeNull();
    }
  });
  it("expands highlighter phrases without requiring the absent literal قلم", () => {
    const target = { productName: "باكيت هايلايت 4 لون CHOSCH H954" };
    for (const query of ["هايلايتر", "قلم تأشير", "قلم تاشير", "highlighter"])
      expect(matchStorefrontSearch(target, query)?.kind).toBe("SYNONYM");
    expect(matchStorefrontSearch(target, "ماركر")).toBeNull();
  });
  it("supports controlled singular and plural keys", () => {
    expect(
      matchStorefrontSearch({ productName: "دفتر سلك" }, "دفاتر")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "قلم جاف" }, "أقلام")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "كراس رسم" }, "كراريس")?.kind,
    ).toBe("SYNONYM");
  });
  it("keeps one-edit corrections separate and never approximates years or model numbers", () => {
    expect(matchStorefrontSearch(workbook, "انكليوي ثالث")).toBeNull();
    expect(matchStorefrontSearch(workbook, "انكليوي ثالث", true)).toMatchObject(
      { kind: "SIMILAR", correction: "انكليزي ثالث" },
    );
    expect(matchStorefrontSearch(workbook, "ملزمة 2028", true)).toBeNull();
    expect(
      matchStorefrontSearch({ productName: "قلم H954" }, "H955", true),
    ).toBeNull();
    expect(
      matchStorefrontSearch({ productName: "قلم abcdef" }, "abcdeg", true)
        ?.kind,
    ).toBe("SIMILAR");
  });
  it("rejects unrelated queries, multiple typos and punctuation-only wildcard searches", () => {
    for (const query of ["سيارة", "%_!", "---", "انكليوي ثالت", "ملزمة 2028"])
      expect(matchStorefrontSearch(workbook, query, true), query).toBeNull();
    expect(
      matchStorefrontSearch(workbook, "ملزمة (ثالث)، ٢٠٢٧!"),
    ).not.toBeNull();
    expect(matchStorefrontSearch(workbook, "ملز%مة")).toBeNull();
  });
  it("ranks direct matches before synonyms and approximate alternatives irrespective of stock", () => {
    const direct = matchStorefrontSearch(
      { productName: "هايلايتر" },
      "هايلايتر",
      true,
    )!;
    const synonym = matchStorefrontSearch(
      { productName: "هايلايت" },
      "هايلايتر",
      true,
    )!;
    const similar = matchStorefrontSearch(workbook, "انكليوي", true)!;
    expect(direct.score).toBeGreaterThan(synonym.score);
    expect(synonym.score).toBeGreaterThan(similar.score);
    expect(
      getStorefrontSearchSuggestions(
        [
          { productName: "دفتر فاخر", inStock: true },
          { productName: "دفتر", inStock: false },
        ],
        "دفتر",
      )[0].productName,
    ).toBe("دفتر");
  });

  it("bridges Iraqi colloquial terms, loanword spellings, definite article ال, and phonetic typos", () => {
    expect(
      matchStorefrontSearch({ productName: "حقيبة لابتوب قماش سميكة" }, "جنطة لابتوب")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "سيت الوان اكرلك 12 لون CLEAR" }, "الوان أكريليك")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "مساحة رصاص ستدلر" }, "محاية")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "مقطاطة معدن" }, "براية")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "باكيت هايلايت 4 لون" }, "قلم فسفوري")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "ملزمة كيمياء ثالث متوسط" }, "الكيمياء الثالث")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "حافظة ورق شفافة" }, "حافظات ورق")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "سبورة مغناطيسية بيضاء" }, "صبورة مغناطسيه", true),
    ).toMatchObject({ kind: "SIMILAR" });
    // مطابقة التأنيث والجمع لغير العاقل وكلمات الربط العراقية والماركات الإنجليزية والكلمات الملتصقة
    expect(
      matchStorefrontSearch({ productName: "دفتر مدرسي 100 ورقة" }, "دفاتر مدرسية")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "قلم ملون جاف" }, "أقلام ملونة")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "اقلام تلوين خشب" }, "الوان خشبية")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "دفتر مدرسي 100 ورقة" }, "دفتر ابو 100")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "قلم سبورة ازرق" }, "قلم مال صبورة")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "ستكي نوت شفاف CLEAR" }, "ستيكي نوت كلير")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "كابسة kangaro LE-210" }, "كباسة كانغارو")?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch({ productName: "ملزمةثالث محمد النوفلي انكليزي المغرب2027" }, "ملزمة ثالث 2027"),
    ).not.toBeNull();
    // تقريب الأغلبية (Partial Quorum) عند وجود كلمة وصفية إضافية في بحث ثلاثي أو رباعي الكلمات
    expect(
      matchStorefrontSearch(workbook, "ملزمة ثالث انكليزي متميزين", true),
    ).toMatchObject({ kind: "SIMILAR", correction: "ملزمه ثالث انكليزي" });
    // الجسور الدلالية الإضافية: «أدوات <-> تجهيزات»، «مصحف شريف -> مصحف»، وتفضيل اسم المنتج على القسم
    expect(
      matchStorefrontSearch(
        { productName: "مسطرة حرف T", category: "التجهيزات الهندسية" },
        "ادوات هندسية",
      )?.kind,
    ).toBe("SYNONYM");
    expect(
      matchStorefrontSearch(
        { productName: "المصحف المجزء وسط" },
        "مصحف شريف",
      )?.kind,
    ).toBe("SYNONYM");
    const schoolBag = matchStorefrontSearch(
      { productName: "حقيبة مدرسية دبلوماسية", category: "الحقائب المدرسية" },
      "جنطة مدرسية",
    )!;
    const sportBagInSchoolCat = matchStorefrontSearch(
      { productName: "جنطة رياضية", category: "الحقائب المدرسية" },
      "جنطة مدرسية",
    )!;
    expect(schoolBag.score).toBeGreaterThan(sportBagInSchoolCat.score);

    // محرك الاسترداد التقريبي العميق: يلتقط خطأين إملائيين معاً ويرفض الأرقام/الرموز غير الموجودة
    const closestMultiTypo = createClosestRelaxedSearchMatcher("ملزمة انكليوي ثالت");
    expect(closestMultiTypo(workbook)).not.toBeNull();
    expect(
      createClosestRelaxedSearchMatcher("ملزمة 2028")(workbook),
    ).toBeNull();
    expect(
      createClosestRelaxedSearchMatcher("سيارة فضائية")(workbook),
    ).toBeNull();
  });
});
