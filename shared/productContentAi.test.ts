import { describe, expect, it } from "vitest";
import {
  aiProductDraftSchema,
  productFactsSchema,
  validateAiProductDraft,
} from "./productContentAi";

const facts = productFactsSchema.parse({
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
