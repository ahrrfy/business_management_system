import { describe, expect, it } from "vitest";
import { nonNegMoneyString, percentString, positiveMoneyString, positiveQtyString, unitPriceString } from "../schemas";

/**
 * الموجة ١ — حدّ ثقة المال/الإشارة (اختبار وحدة نقي، بلا قاعدة بيانات).
 * يُثبت أن مُحقِّقات zod تَردّ السالب/الصفر/الشاذّ على حدّ الـAPI قبل بلوغ money()/decimal.js.
 * يُغلق على مستوى الإدخال: PROC-01 (سعر شراء سالب)، PROC-02 (سعر مرتجع سالب)،
 * PROC-03 (نسبة ضريبة سالبة/>١٠٠)، SALES-04 (مبلغ دفع غير مُنسّق).
 */
describe("Wave 1 — money/qty/percent trust-boundary zod helpers", () => {
  it("nonNegMoneyString: يَقبل ≥0 بمنزلتين، يَردّ السالب/>2dp/الأسّي (PROC-01/02)", () => {
    for (const ok of ["0", "0.00", "1", "1500.25", "999999.99"]) {
      expect(nonNegMoneyString.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["-1", "-0.01", "1.234", "1e3", "abc", "", "1,5", " 1"]) {
      expect(nonNegMoneyString.safeParse(bad).success).toBe(false);
    }
  });

  it("positiveMoneyString: يَردّ الصفر والسالب بلا parseFloat (§٥)", () => {
    for (const ok of ["0.01", "1", "10.50", "0.10"]) {
      expect(positiveMoneyString.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["0", "0.00", "00.00", "0.0", "-5", "-0.01"]) {
      expect(positiveMoneyString.safeParse(bad).success).toBe(false);
    }
  });

  it("positiveQtyString: >0 حتى ٣ منازل، يَردّ الصفر/السالب", () => {
    for (const ok of ["1", "0.001", "12.5", "0.250"]) {
      expect(positiveQtyString.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["0", "0.000", "-1", "1.2345", "-0.5"]) {
      expect(positiveQtyString.safeParse(bad).success).toBe(false);
    }
  });

  it("unitPriceString: سعر وحدةٍ غير سالب حتى ٤ منازل — يقبل 1450.99 و3.4566 (بلاغ ١٧/٨)", () => {
    // نواة البلاغ: كلاهما كان يُردّ أو يُقصّ صامتاً على حدّ الـAPI رغم أنّ العمود
    // `purchaseOrderItems.usdUnitPrice` مُعرَّف decimal(15,4).
    for (const ok of ["1450.99", "3.4566", "0", "0.0001", "41.48", "999999.9999"]) {
      expect(unitPriceString.safeParse(ok).success).toBe(true);
    }
    // السقف أربع منازل، والسالب/الصيغ التالفة/الفاصلة الألفية مردودة كما في بقيّة المخطّطات.
    for (const bad of ["3.45666", "-1", "-0.0001", "1e3", "abc", "", "1,450.99", " 1", "1."]) {
      expect(unitPriceString.safeParse(bad).success).toBe(false);
    }
  });

  it("unitPriceString أوسع من nonNegMoneyString — التضييق حسب العملة مسؤولية الخدمة", () => {
    // ٤ منازل تمرّ من عقد الراوتر ثمّ تُضيَّق داخل computePurchaseDocument (الدينار منزلتان)،
    // لأنّ العملة معلومةٌ على مستوى المستند لا على مستوى الحقل.
    expect(unitPriceString.safeParse("3.4566").success).toBe(true);
    expect(nonNegMoneyString.safeParse("3.4566").success).toBe(false);
  });

  it("percentString: [0,100]، يَردّ السالب و>100 (PROC-03)", () => {
    for (const ok of ["0", "0.00", "15.5", "100", "100.00"]) {
      expect(percentString.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["100.01", "101", "200", "-1", "-0.01"]) {
      expect(percentString.safeParse(bad).success).toBe(false);
    }
  });
});
