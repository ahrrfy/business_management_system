import { describe, expect, it } from "vitest";
import { STUDIO_TEMPLATE, computeProductRect, computeShadowEllipse } from "../template";

describe("computeProductRect — الوضع الموحّد", () => {
  it("مصدر مربّع بالافتراضي (90٪) ⇒ مربّع مركزيّ بارز بهامش متساوٍ", () => {
    const r = computeProductRect(500, 500, 1000);
    expect(r.width).toBeCloseTo(900);
    expect(r.height).toBeCloseTo(900);
    expect(r.x).toBeCloseTo(50);
    expect(r.y).toBeCloseTo(50);
  });

  it("مصدر عريض بالافتراضي ⇒ العرض=90٪ والارتفاع أصغر، مركزيّ عمودياً", () => {
    const r = computeProductRect(800, 400, 1000);
    expect(r.width).toBeCloseTo(900);
    expect(r.height).toBeCloseTo(450);
    expect(r.x).toBeCloseTo(50);
    expect(r.y).toBeCloseTo(275);
  });

  it("مصدر طويل بالافتراضي ⇒ الارتفاع=90٪ والعرض أصغر، مركزيّ أفقياً", () => {
    const r = computeProductRect(400, 800, 1000);
    expect(r.height).toBeCloseTo(900);
    expect(r.width).toBeCloseTo(450);
    expect(r.y).toBeCloseTo(50);
    expect(r.x).toBeCloseTo(275);
  });

  it("يكبّر المصدر الصغير ليوحّد الحجم (لا يُترَك صغيراً)", () => {
    const r = computeProductRect(100, 100, 1000);
    expect(r.width).toBeCloseTo(900);
  });

  it("يقبل نسبة مخصصة قديمة عند الحاجة", () => {
    const r = computeProductRect(500, 500, 1000, 0.82);
    expect(r.width).toBeCloseTo(820);
    expect(r.height).toBeCloseTo(820);
    expect(r.x).toBeCloseTo(90);
    expect(r.y).toBeCloseTo(90);
  });

  it("يرفض أبعاداً غير صحيحة", () => {
    expect(() => computeProductRect(0, 100)).toThrow();
    expect(() => computeProductRect(100, -5)).toThrow();
  });
});

describe("computeShadowEllipse — ظلّ التماس", () => {
  it("بيضاوي مركزيّ أفقياً أسفل قاع المنتج، مسطّح", () => {
    const rect = computeProductRect(500, 500, 1000); // x=50 y=50 w=900 h=900
    const s = computeShadowEllipse(rect, 1000);
    expect(s.cx).toBeCloseTo(rect.x + rect.width / 2); // 500
    expect(s.cy - s.ry).toBeGreaterThanOrEqual(rect.y + rect.height); // حافة الظلّ العليا أسفل القاع
    expect(s.rx).toBeCloseTo((rect.width * STUDIO_TEMPLATE.shadow.widthRatio) / 2);
    expect(s.rx).toBeGreaterThan(s.ry); // مسطّح (عرض > ارتفاع)
  });
});
