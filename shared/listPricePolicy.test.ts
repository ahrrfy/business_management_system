import { describe, expect, it } from "vitest";
import {
  baseUnitPriceRequiredMessage,
  isPositivePriceString,
  missingListPriceMessage,
  PRICE_TIER_LABEL_AR,
} from "./listPricePolicy";

/**
 * H7 — سياسة سعر القائمة الإلزاميّ (قرار المالك ١٨/٨/٢٦).
 * الجوهر المُختبَر هنا: **الصفر ليس سعراً**. عليه يقوم الحارس كلّه، ولأنّه غير بديهيّ
 * (صفٌّ موجودٌ بقيمة `0.00` يبدو «سعراً مُعرَّفاً») يُثبَّت صراحةً كي لا يُلَيَّن لاحقاً.
 */
describe("isPositivePriceString — الصفر ليس سعراً", () => {
  it("يقبل السعر الموجب بكل صوره", () => {
    for (const ok of ["1", "0.01", "1450.99", "10000", "0.5", " 250 ", "3.4566"]) {
      expect(isPositivePriceString(ok)).toBe(true);
    }
  });

  it("يرفض الغياب والصفر بكل صوره — وهو مربط الفرس", () => {
    // `0.00` هو ما تكتبه البطاقات الرقمية كعنصرٍ نائب، و`""` ما يتركه محرّر المنتج.
    // كلاهما أمام القسمة في بوّابة الانحراف مقامٌ صفر ⇒ لا حارس.
    for (const bad of ["", "   ", "0", "0.0", "0.00", "0.000"]) {
      expect(isPositivePriceString(bad)).toBe(false);
    }
    expect(isPositivePriceString(null)).toBe(false);
    expect(isPositivePriceString(undefined)).toBe(false);
  });

  it("يرفض السالب والنصّ التالف بلا انهيار (لا Number ⇒ لا NaN صامت)", () => {
    for (const bad of ["-1", "-0.01", "abc", "1.2.3", "1e3", "١٢٣", "1,450.99", "1450.99د"]) {
      expect(isPositivePriceString(bad)).toBe(false);
    }
  });
});

describe("رسائل الرفض — قابلةٌ للتنفيذ لا عمياء", () => {
  it("رسالة البيع تسمّي البند والوحدة والفئة وتدلّ على موضع الإصلاح", () => {
    const m = missingListPriceMessage({ itemLabel: "دفتر ١٠٠ ورقة — أزرق", unitLabel: "قطعة", tier: "WHOLESALE" });
    expect(m).toContain("دفتر ١٠٠ ورقة — أزرق");
    expect(m).toContain("قطعة");
    expect(m).toContain("جملة"); // الفئة بالعربية لا بالرمز
    expect(m).toContain("المنتجات ← تعديل الصنف"); // أين يُصلَح
  });

  it("بلا اسم وحدة ⇒ رسالةٌ سليمةٌ بلا قوسٍ فارغ", () => {
    const m = missingListPriceMessage({ itemLabel: "قلم", tier: "RETAIL" });
    expect(m).toContain("قلم");
    expect(m).not.toContain("()");
    expect(m).not.toContain("undefined");
  });

  it("رسالة المحرّر تعرض المخرج المشروع (تعطيل الصنف) لا الرفض وحده", () => {
    const m = baseUnitPriceRequiredMessage({ variantLabel: "SKU-9", unitLabel: "حبة" });
    expect(m).toContain("SKU-9");
    expect(m).toContain("حبة");
    expect(m).toContain("للشراء فقط"); // المخرج: صنفٌ لا يُباع
  });

  it("قاموس الفئات مطابقٌ لفئات التسعير الثلاث", () => {
    expect(Object.keys(PRICE_TIER_LABEL_AR).sort()).toEqual(["GOVERNMENT", "RETAIL", "WHOLESALE"]);
  });
});
