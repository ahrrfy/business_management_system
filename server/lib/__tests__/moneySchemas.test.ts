import { describe, expect, it } from "vitest";
import { nonNegMoneyString, percentString, positiveMoneyString, positiveQtyString } from "../schemas";

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

  it("percentString: [0,100]، يَردّ السالب و>100 (PROC-03)", () => {
    for (const ok of ["0", "0.00", "15.5", "100", "100.00"]) {
      expect(percentString.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["100.01", "101", "200", "-1", "-0.01"]) {
      expect(percentString.safeParse(bad).success).toBe(false);
    }
  });
});
