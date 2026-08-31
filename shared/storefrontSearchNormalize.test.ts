import { describe, expect, it } from "vitest";
import { ARABIC_NORMALIZATION_PAIRS, normalizeArabicSearch } from "./storefrontSearchNormalize";

describe("normalizeArabicSearch", () => {
  it("folds alef variants to bare alef so hamza-agnostic queries hit hamza-carrying products", () => {
    // العطبُ الذي فرك #904 لم يفركه كلّياً: «اوراق» (بلا همزة) يجب أن يطابق «أوراق»/«إوراق»/«آوراق»
    // في القاعدة، لا في العميل وحده. النصّ المُطبَّع هنا هو ما يُرسَل إلى `LIKE`.
    expect(normalizeArabicSearch("أوراق")).toBe("اوراق");
    expect(normalizeArabicSearch("إوراق")).toBe("اوراق");
    expect(normalizeArabicSearch("آوراق")).toBe("اوراق");
    expect(normalizeArabicSearch("اوراق")).toBe("اوراق"); // idempotent
  });

  it("folds taa marbuta (ة) to haa (ه) — common variant in casual typing", () => {
    expect(normalizeArabicSearch("علبة")).toBe("علبه");
    expect(normalizeArabicSearch("علبه")).toBe("علبه");
  });

  it("collapses whitespace and trims — normalized term is safe for LIKE pattern with escLike", () => {
    expect(normalizeArabicSearch("  دفتر   احضار  ")).toBe("دفتر احضار");
    expect(normalizeArabicSearch("\tقلم\nازرق")).toBe("قلم ازرق");
  });

  it("is idempotent — normalizing an already-normalized value returns it unchanged", () => {
    const original = "دفتر احضار";
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
    // العقد التركيبيّ مع الخادم: عبارة SQL تُبنى بـREPLACE متسلسل على هذه الأزواج بالترتيب،
    // وأيّ إضافة/حذف يُغيّر النتيجة يجب أن يُغيّر هذا الاختبار — تحذيرٌ من انحرافٍ صامتٍ بين العميل والخادم.
    expect(ARABIC_NORMALIZATION_PAIRS).toEqual([
      ["أ", "ا"],
      ["إ", "ا"],
      ["آ", "ا"],
      ["ة", "ه"],
    ]);
  });
});
