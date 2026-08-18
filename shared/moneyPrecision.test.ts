import { describe, expect, it } from "vitest";
import {
  IQD_PRICE_DECIMALS,
  MAX_PRICE_DECIMALS,
  USD_PRICE_DECIMALS,
  countPriceDecimals,
  isWithinPriceDecimals,
  priceDecimalsFor,
  priceDecimalsMessage,
} from "./moneyPrecision";

/**
 * بلاغ المالك (١٧/٨/٢٦): «سعر الشراء لا يمكن أن يكون 1,450.99، وبالدولار لا يقبل 3.4566».
 * هذه الحزمة تُثبّت **سياسة الدقّة** التي تستهلكها الطبقات الثلاث (الحقل، حمولة الشاشة، الخدمة):
 * الدينار منزلتان (عمود decimal(15,2))، والدولار أربع (عمود usdUnitPrice decimal(15,4)).
 */
describe("moneyPrecision — دقّة سعر الوحدة حسب العملة", () => {
  it("يثبّت الحدود: الدينار ٢، الدولار ٤، والسقف الأعلى = دقّة الدولار", () => {
    expect(IQD_PRICE_DECIMALS).toBe(2);
    expect(USD_PRICE_DECIMALS).toBe(4);
    expect(MAX_PRICE_DECIMALS).toBe(USD_PRICE_DECIMALS);
    expect(priceDecimalsFor("IQD")).toBe(2);
    expect(priceDecimalsFor("USD")).toBe(4);
  });

  it("العملة المجهولة/الغائبة تسقط على سياسة الدينار (الأضيق = الأأمن)", () => {
    expect(priceDecimalsFor(undefined)).toBe(2);
    expect(priceDecimalsFor(null)).toBe(2);
    expect(priceDecimalsFor("EUR")).toBe(2);
  });

  it("countPriceDecimals يعدّ المنازل الدالّة بلا Number ولا يحتسب الأصفار الذيليّة", () => {
    expect(countPriceDecimals("1450")).toBe(0);
    expect(countPriceDecimals("1450.99")).toBe(2);
    expect(countPriceDecimals("3.4566")).toBe(4);
    // الأصفار الذيليّة ليست دقّةً: «3.4500» = منزلتان فعليّتان ⇒ تمرّ بالدينار أيضاً.
    expect(countPriceDecimals("3.4500")).toBe(2);
    expect(countPriceDecimals("3.400000")).toBe(1);
    expect(countPriceDecimals("5.00")).toBe(0);
    // النصّ التالف يُميَّز عن «دقّة زائدة» كي تختلف الرسالة.
    for (const bad of ["", " ", "abc", "1,450.99", "1.2.3", "1e3", ".", "١٤٥٠"]) {
      expect(countPriceDecimals(bad)).toBe(-1);
    }
  });

  it("الدينار يقبل حتى منزلتين — 1450.99 مقبولة (نواة البلاغ)", () => {
    for (const ok of ["1450.99", "1450.9", "1450", "0", "0.05", "1450.9900"]) {
      expect(isWithinPriceDecimals(ok, "IQD")).toBe(true);
    }
    for (const bad of ["1450.999", "3.4566", "0.001"]) {
      expect(isWithinPriceDecimals(bad, "IQD")).toBe(false);
    }
  });

  it("الدولار يقبل حتى أربع منازل — 3.4566 مقبولة (نواة البلاغ)", () => {
    for (const ok of ["3.4566", "3.456", "3.45", "3", "41.4800", "0.0001"]) {
      expect(isWithinPriceDecimals(ok, "USD")).toBe(true);
    }
    for (const bad of ["3.45666", "3.456789"]) {
      expect(isWithinPriceDecimals(bad, "USD")).toBe(false);
    }
  });

  it("النصّ التالف يُردّ في كل العملات (لا يمرّ كـ«صفر منازل»)", () => {
    for (const bad of ["", "abc", "1,450.99", "1.2.3"]) {
      expect(isWithinPriceDecimals(bad, "IQD")).toBe(false);
      expect(isWithinPriceDecimals(bad, "USD")).toBe(false);
    }
  });

  it("رسالة الرفض تُصرّح بالعملة والحدّ والقيمة المُدخَلة ولا تعِد بتقريبٍ تلقائيّ", () => {
    const msg = priceDecimalsMessage("USD", "قلم أزرق — SKU-1", "3.45666");
    expect(msg).toContain("الدولار");
    expect(msg).toContain("4");
    expect(msg).toContain("قلم أزرق — SKU-1");
    expect(msg).toContain("3.45666");
    expect(priceDecimalsMessage("IQD", "دفتر")).toContain("الدينار");
    expect(priceDecimalsMessage("IQD", "دفتر")).toContain("2");
  });
});
