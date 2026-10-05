/**
 * تلميحات الأسعار تحت اسم الصنف (`LinePriceHints.tsx`) — عرضٌ بلا شبكة ولا قاعدة.
 * يحرس: لا ادّعاء قبل وصول الجواب، نصوص التنبيه حسب الحالة، زرّ «استخدم» ومتى يختفي، وعدم تسرّب
 * أيّ حقل تكلفة (المكوّن لا يستقبل تكلفةً أصلاً).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SaleLineInsight, SaleRef } from "@shared/priceAlerts";
import { ContractPriceHint, SaleLastPriceHints, ageLabel } from "../LinePriceHints";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const sale = (price: string, over: Partial<SaleRef> = {}): SaleRef => ({
  invoiceId: 10,
  invoiceNumber: "INV-1-20260923-00043",
  price,
  discountPercent: "0",
  at: "2026-09-23T12:00:00.000Z",
  ...over,
});
const html = (insight: SaleLineInsight | undefined, enteredPrice: string, onUse?: (p: string) => void) =>
  renderToStaticMarkup(
    <SaleLastPriceHints insight={insight} enteredPrice={enteredPrice} onUsePrice={onUse} now={NOW} />,
  );

describe("SaleLastPriceHints", () => {
  it("لم يصل الجواب بعدُ (undefined) ⇒ لا شيء — لا ادّعاء بلا دليل", () => {
    expect(html(undefined, "1000")).toBe("");
  });

  it("عميلٌ لم يشترِ الصنف ⇒ «أول بيع» ولا زرّ", () => {
    const out = html({ lastSales: [] }, "1000", () => {});
    expect(out).toContain("لا بيع سابق ظاهر لك لهذا الصنف مع هذا العميل");
    expect(out).not.toContain("استخدم");
  });

  it("آخر بيع: السعر + العمر + رقم الفاتورة، وأقلّ بنسبة ظاهرة، وزرّ استخدم", () => {
    const out = html({ lastSales: [sale("1000")] }, "900", () => {});
    expect(out).toContain("آخر بيع لهذا العميل");
    expect(out).toContain("1,000");
    expect(out).toContain("قبل 12 يوماً");
    expect(out).toContain("INV-1-20260923-00043");
    expect(out).toContain("أقل من آخر سعر بيع بـ 10.0%");
    expect(out).toContain("استخدم");
    expect(out).toContain("--sem-warn");
  });

  it("نزولٌ ≥١٥٪ بلون الخطر؛ والارتفاع معلومةٌ هادئة", () => {
    expect(html({ lastSales: [sale("1000")] }, "800", () => {})).toContain("--sem-neg");
    const up = html({ lastSales: [sale("1000")] }, "1100", () => {});
    expect(up).toContain("أعلى من آخر سعر بيع بـ 10.0%");
    expect(up).not.toContain("--sem-neg");
  });

  it("نفس السعر ⇒ علامة صحّ ولا زرّ (لا معنى لاستعادة ما هو مُدخَل)", () => {
    const out = html({ lastSales: [sale("1000.00")] }, "1000", () => {});
    expect(out).toContain("نفس آخر سعر بيع");
    expect(out).not.toContain("استخدم");
  });

  it("بلا onUsePrice (للقراءة فقط) ⇒ لا زرّ", () => {
    expect(html({ lastSales: [sale("1000")] }, "900")).not.toContain("استخدم");
  });

  it("خصم البيع السابق يظهر نصّاً صريحاً", () => {
    expect(html({ lastSales: [sale("1000", { discountPercent: "5" })] }, "1000")).toContain("بخصم");
  });

  it("سعرٌ مُدخَل فارغ ⇒ يعرض المرجع دون تنبيهٍ مقارِن", () => {
    const out = html({ lastSales: [sale("1000")] }, "");
    expect(out).not.toContain("آخر سعر بيع بـ");
  });
});

describe("ageLabel", () => {
  it("صياغة العدد العربيّة", () => {
    expect(ageLabel(0)).toBe("اليوم");
    expect(ageLabel(1)).toBe("أمس");
    expect(ageLabel(2)).toBe("قبل يومين");
    expect(ageLabel(7)).toBe("قبل 7 أيام");
    expect(ageLabel(30)).toBe("قبل 30 يوماً");
    expect(ageLabel(null)).toBe("");
  });
});

describe("SaleLastPriceHints — سعرٌ فارغ", () => {
  it("السعر فارغ/صفر ⇒ يبقى «آخر بيع» وزرّ «استخدم» بلا تنبيه مقارنة", () => {
    for (const entered of ["", "0", "  "]) {
      const out = html({ lastSales: [sale("1000")] }, entered, () => {});
      expect(out).toContain("آخر بيع لهذا العميل");
      expect(out).toContain("استخدم");
      expect(out).not.toContain("أقل من آخر سعر");
    }
  });
});

describe("ContractPriceHint", () => {
  const out = (over: Partial<Parameters<typeof ContractPriceHint>[0]> = {}) =>
    renderToStaticMarkup(
      <ContractPriceHint priceSource="CONTRACT" referencePrice="900" enteredPrice="900" onRestore={() => {}} {...over} />,
    );

  it("سعر الكتالوج لم يُمسّ ⇒ شارة «سعر تعاقدي» بلا تحذير ولا زرّ", () => {
    const h = out();
    expect(h).toContain("سعر تعاقدي للعميل");
    expect(h).not.toContain("يختلف");
    expect(h).not.toContain("استعد");
  });

  it("عُدّل السعر عن التعاقدي ⇒ تنبيه بالسعر التعاقدي وزرّ استعد", () => {
    const h = out({ enteredPrice: "850" });
    expect(h).toContain("يختلف عن السعر التعاقدي");
    expect(h).toContain("900");
    expect(h).toContain("استعد");
  });

  it("شاشة للقراءة فقط ⇒ التنبيه بلا زرّ", () => {
    const h = out({ enteredPrice: "850", onRestore: undefined });
    expect(h).toContain("يختلف");
    expect(h).not.toContain("استعد");
  });

  it("السعر من الفئة (TIER) أو بلا مرجع أو غير قابل للقراءة ⇒ لا شيء", () => {
    expect(out({ priceSource: "TIER" })).toBe("");
    expect(out({ priceSource: null })).toBe("");
    expect(out({ referencePrice: null })).toBe("");
    expect(out({ referencePrice: "abc" })).toBe("");
  });

  it("المساواة عدديّة لا نصّيّة (900.00 = 900)", () => {
    expect(out({ referencePrice: "900.00", enteredPrice: "900" })).not.toContain("يختلف");
  });
});