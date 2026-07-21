import { describe, expect, it } from "vitest";
import { STUDIO_TEMPLATE, computeProductRect, computeShadowEllipse } from "../template";

describe("computeProductRect — الوضع الموحّد", () => {
  it("مصدر مربّع ⇒ مربّع مركزيّ بأكبر بُعد = 82٪ والهامش موحّد", () => {
    const r = computeProductRect(500, 500, 1000, 0.82);
    expect(r.width).toBeCloseTo(820);
    expect(r.height).toBeCloseTo(820);
    expect(r.x).toBeCloseTo(90);
    expect(r.y).toBeCloseTo(90);
  });

  it("مصدر عريض ⇒ العرض=82٪ والارتفاع أصغر، مركزيّ عمودياً", () => {
    const r = computeProductRect(800, 400, 1000, 0.82);
    expect(r.width).toBeCloseTo(820);
    expect(r.height).toBeCloseTo(410);
    expect(r.x).toBeCloseTo(90);
    expect(r.y).toBeCloseTo(295);
  });

  it("مصدر طويل ⇒ الارتفاع=82٪ والعرض أصغر، مركزيّ أفقياً", () => {
    const r = computeProductRect(400, 800, 1000, 0.82);
    expect(r.height).toBeCloseTo(820);
    expect(r.width).toBeCloseTo(410);
    expect(r.y).toBeCloseTo(90);
    expect(r.x).toBeCloseTo(295);
  });

  it("يكبّر المصدر الصغير ليوحّد الحجم (لا يُترَك صغيراً)", () => {
    const r = computeProductRect(100, 100, 1000, 0.82);
    expect(r.width).toBeCloseTo(820);
  });

  it("يرفض أبعاداً غير صحيحة", () => {
    expect(() => computeProductRect(0, 100)).toThrow();
    expect(() => computeProductRect(100, -5)).toThrow();
  });
});

describe("computeShadowEllipse — ظلّ التماس", () => {
  it("بيضاوي مركزيّ أفقياً أسفل قاع المنتج، مسطّح", () => {
    const rect = computeProductRect(500, 500, 1000, 0.82); // x=90 y=90 w=820 h=820
    const s = computeShadowEllipse(rect, 1000);
    expect(s.cx).toBeCloseTo(rect.x + rect.width / 2); // 500
    expect(s.cy - s.ry).toBeGreaterThanOrEqual(rect.y + rect.height); // حافة الظلّ العليا أسفل القاع
    expect(s.rx).toBeCloseTo((rect.width * STUDIO_TEMPLATE.shadow.widthRatio) / 2);
    expect(s.rx).toBeGreaterThan(s.ry); // مسطّح (عرض > ارتفاع)
  });
});
