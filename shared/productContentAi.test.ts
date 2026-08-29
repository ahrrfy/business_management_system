import { describe, expect, it } from "vitest";
import {
  aiProductDraftSchema,
  extractedProductFactsSchema,
  normalizeConversionFactor,
  productFactsSchema,
  validateAiProductDraft,
} from "./productContentAi";

const facts = productFactsSchema.parse({
  finalProductName: "دفتر ملاحظات سلك A5 من روتا",
  inputDescription: "دفتر للكتابة اليومية",
  category: "قرطاسية",
  productType: "دفتر ملاحظات",
  brand: "روتا",
  modelName: "سلك A5",
  attributes: { sheets: "100 ورقة", binding: "سلك معدني" },
  variants: [{ color: "أزرق" }],
  saleUnits: [{ name: "قطعة", conversionFactor: "1" }],
  verifiedClaims: [],
  audience: "طلاب",
});

const validDraft = aiProductDraftSchema.parse({
  seoTitle: "دفتر ملاحظات سلك A5 من روتا - 100 ورقة",
  shortTitle: "دفتر سلك A5 - 100 ورقة",
  posLabel: "دفتر روتا سلك A5 100 ورقة",
  invoiceLabel: "دفتر سلك A5 100 ورقة / أزرق / قطعة",
  marketingCopy: "دفتر عملي للكتابة اليومية بحجم A5 وسعة 100 ورقة.",
  description: "دفتر ملاحظات بحجم A5 يحتوي على 100 ورقة ومجلد بسلك معدني.",
  keywords: ["دفتر ملاحظات A5", "دفتر سلك"],
  claims: [
    { text: "بحجم A5", evidenceKeys: ["modelName"] },
    { text: "يحتوي على 100 ورقة", evidenceKeys: ["attributes.sheets"] },
  ],
  unsupportedClaims: [],
  warnings: [],
  confidence: "high",
});

describe("productContentAi", () => {
  it("preserves entered name and description as non-evidence context", () => {
    expect(facts.finalProductName).toBe("دفتر ملاحظات سلك A5 من روتا");
    expect(facts.inputDescription).toBe("دفتر للكتابة اليومية");
  });

  it("accepts a draft whose claims cite existing facts", () => {
    const result = validateAiProductDraft(validDraft, facts);
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("blocks unknown evidence keys", () => {
    const draft = aiProductDraftSchema.parse({
      ...validDraft,
      claims: [
        { text: "مقاوم للماء", evidenceKeys: ["attributes.waterproof"] },
      ],
    });
    const result = validateAiProductDraft(draft, facts);
    expect(result.ok).toBe(false);
    expect(
      result.blockers.some((item) => item.includes("attributes.waterproof")),
    ).toBe(true);
  });

  it("blocks a claim that cites an existing fact but is not grounded in its value", () => {
    const draft = aiProductDraftSchema.parse({
      ...validDraft,
      claims: [{ text: "يدعم الشحن اللاسلكي", evidenceKeys: ["brand"] }],
    });
    const result = validateAiProductDraft(draft, facts);
    expect(result.ok).toBe(false);
    expect(
      result.blockers.some((item) => item.includes("لا يتطابق نصياً")),
    ).toBe(true);
  });

  it("does not treat free-form context as evidence for a partial claim", () => {
    const draft = aiProductDraftSchema.parse({
      ...validDraft,
      claims: [{ text: "دفتر مصنوع من الذهب", evidenceKeys: ["productType"] }],
    });
    const result = validateAiProductDraft(draft, facts);
    expect(result.ok).toBe(false);
    expect(
      result.blockers.some((item) => item.includes("لا يتطابق نصياً")),
    ).toBe(true);
  });

  it("blocks numeric tokens that are not in verified facts", () => {
    const draft = aiProductDraftSchema.parse({
      ...validDraft,
      seoTitle: "دفتر A4 - 200 ورقة",
    });
    const result = validateAiProductDraft(draft, facts);
    expect(result.ok).toBe(false);
    expect(result.blockers.some((item) => item.includes("200"))).toBe(true);
  });

  it("blocks unsupported marketing claims", () => {
    const draft = aiProductDraftSchema.parse({
      ...validDraft,
      marketingCopy: "أفضل دفتر مضمون وأصلي للاستخدام اليومي.",
    });
    const result = validateAiProductDraft(draft, facts);
    expect(result.ok).toBe(false);
    expect(result.blockers.some((item) => item.includes("أفضل"))).toBe(true);
  });
});

describe("normalizeConversionFactor", () => {
  const cases: Array<[string | null | undefined, string]> = [
    ["12", "12"],
    ["1.5", "1.5"],
    ["1,5", "1.5"],
    ["1٫5", "1.5"],
    ["١٢", "12"],
    ["٠١٢", "12"],
    ["12.", "12"],
    ["12.0", "12"],
    ["12.50", "12.5"],
    ["  12  ", "12"],
    ["", "1"],
    [null, "1"],
    [undefined, "1"],
  ];
  cases.forEach(([input, expected]) => {
    it(`normalizes ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      const normalized = normalizeConversionFactor(input);
      expect(normalized).toBe(expected);
      // مرور السكيمة على القيمة المُطبَّعة (الاختبار الحاسم — لأنّ الخادم يرفض ما يخالف الregex).
      expect(() =>
        productFactsSchema.parse({
          finalProductName: "منتج",
          saleUnits: [{ name: "درزن", conversionFactor: normalized }],
        }),
      ).not.toThrow();
    });
  });

  it("leaves malformed input unchanged (server-side rejection surfaces exact reason)", () => {
    // مدخل غير مفهوم يظلّ كما هو، فيرفضه الخادم برسالةٍ عن الحقل ⇒ أوضح من تحويلٍ صامتٍ خاطئ.
    expect(normalizeConversionFactor("abc")).toBe("abc");
    expect(normalizeConversionFactor("1/2")).toBe("1/2");
  });
});

describe("vision evidence (image.N keys)", () => {
  it("accepts image.N in evidenceKeys through the schema", () => {
    expect(() =>
      aiProductDraftSchema.parse({
        ...validDraft,
        claims: [
          { text: "بحجم A5", evidenceKeys: ["modelName"] },
          // ادّعاء بصريّ خالص — بلا دليلٍ نصّيّ في الحقائق.
          { text: "لون أزرق ظاهر", evidenceKeys: ["image.0"] },
          // ادّعاء مختلط — دليلٌ نصّيّ + بصريّ.
          { text: "دفتر ملاحظات أزرق", evidenceKeys: ["productType", "image.0"] },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects malformed image keys (image.abc, image., image, images.0)", () => {
    for (const bad of ["image.abc", "image.", "image", "images.0", "image.-1"]) {
      expect(() =>
        aiProductDraftSchema.parse({
          ...validDraft,
          claims: [{ text: "أزرق", evidenceKeys: [bad] }],
        }),
      ).toThrow();
    }
  });

  it("image-only claim is accepted without textual grounding", () => {
    // «لون أزرق» لا يظهر في أيّ حقلٍ نصّيّ (facts.variants[0].color = 'أزرق' حاضر لكن كوّناً مستقلاً).
    // الادّعاء المستند إلى image.0 يجب ألّا يخضع لفحص «التطابق النصّيّ» — البروتوكول البصريّ في
    // البرومبت + مراجعة المدير هما الحارسان.
    const draft = aiProductDraftSchema.parse({
      ...validDraft,
      claims: [
        { text: "بحجم A5", evidenceKeys: ["modelName"] },
        { text: "شعار روتا ظاهر أعلى الغلاف", evidenceKeys: ["image.0"] },
      ],
    });
    const result = validateAiProductDraft(draft, facts);
    expect(result.ok).toBe(true);
    // لا حاصر عن الادّعاء البصريّ (رقم ٢).
    expect(result.blockers.some((b) => b.includes("رقم 2"))).toBe(false);
  });

  it("extractedProductFactsSchema accepts a well-formed extraction result", () => {
    const parsed = extractedProductFactsSchema.parse({
      suggestedName: "دفتر ملاحظات روتا سلك A5",
      productType: "دفتر ملاحظات",
      brand: "روتا",
      modelHint: "A5",
      description: "دفتر مجلَّد بسلك، غلاف أزرق داكن، حجم متوسط.",
      keywords: ["دفتر", "سلك", "A5"],
      confidence: "high",
      unsupportedGuesses: [
        { text: "100 ورقة", reason: "لا رقم ظاهرٌ على الغلاف" },
      ],
    });
    expect(parsed.brand).toBe("روتا");
    expect(parsed.unsupportedGuesses).toHaveLength(1);
  });

  it("extractedProductFactsSchema accepts nulls for all optional facts", () => {
    // صورةٌ غامضة ⇒ النموذج يُعيد كلّ حقلٍ null ووصفاً فارغاً، والسكيمة تقبله.
    // الواجهة تعرض «— لم يتبيّن —» وزرّ «طبّق» لا يُغيّر شيئاً على النموذج.
    const parsed = extractedProductFactsSchema.parse({
      suggestedName: null,
      productType: null,
      brand: null,
      modelHint: null,
      description: "",
      keywords: [],
      confidence: "low",
      unsupportedGuesses: [],
    });
    expect(parsed.description).toBe("");
    expect(parsed.suggestedName).toBeNull();
  });

  it("extractedProductFactsSchema rejects extra properties and out-of-range enums", () => {
    // strict() ⇒ حقلٌ غير معلَنٍ يفشل، وهو ما يمنع النموذجَ من تهريب سعرٍ/كميّةٍ ابتلعتهما الواجهة.
    expect(() =>
      extractedProductFactsSchema.parse({
        suggestedName: null,
        productType: null,
        brand: null,
        modelHint: null,
        description: "",
        keywords: [],
        confidence: "high",
        unsupportedGuesses: [],
        price: "5000", // ⛔
      }),
    ).toThrow();
    expect(() =>
      extractedProductFactsSchema.parse({
        suggestedName: null,
        productType: null,
        brand: null,
        modelHint: null,
        description: "",
        keywords: [],
        confidence: "أعلى", // ⛔ خارج enum
        unsupportedGuesses: [],
      }),
    ).toThrow();
  });

  it("mixed claim still requires textual evidence to match", () => {
    // ادّعاء يحمل دليلاً نصّياً غير مطابقٍ + دليلاً بصريّاً ⇒ يفشل على النصّيّ (لا يُغني عنه البصريّ).
    const draft = aiProductDraftSchema.parse({
      ...validDraft,
      claims: [
        { text: "بحجم A5", evidenceKeys: ["modelName"] },
        // «سلك حديد» ليس في modelName (الذي يحمل «سلك A5») + دليلٌ بصريّ ⇒ يفشل على النصّيّ.
        { text: "سلك حديد", evidenceKeys: ["modelName", "image.0"] },
      ],
    });
    const result = validateAiProductDraft(draft, facts);
    expect(result.ok).toBe(false);
    expect(
      result.blockers.some((b) => b.includes("رقم 2") && b.includes("لا يتطابق")),
    ).toBe(true);
  });
});
