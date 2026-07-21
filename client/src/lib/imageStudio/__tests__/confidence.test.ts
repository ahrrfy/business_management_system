import { describe, expect, it } from "vitest";
import { analyzeMask } from "../confidence";

const W = 100;
const H = 100;
const blank = (fill = 0) => new Uint8Array(W * H).fill(fill);
const rect = (m: Uint8Array, x0: number, y0: number, x1: number, y1: number, v: number) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = v;
  return m;
};

describe("analyzeMask — قرار CUT/FLATTEN (حواجز §٥)", () => {
  it("منتج صلب مركزيّ بحواف حادّة ⇒ CUT بلا ثقوب", () => {
    const m = rect(blank(0), 30, 30, 70, 70, 255);
    const r = analyzeMask(m, W, H);
    expect(r.mode).toBe("CUT");
    expect(r.hasInternalHoles).toBe(false);
    expect(r.touchesFrame).toBe(false);
    expect(r.foregroundRatio).toBeCloseTo(0.16, 2);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("ثقب شفّاف محبوس داخل المنتج ⇒ FLATTEN (خطر محو نصّ داخليّ)", () => {
    const m = rect(blank(0), 20, 20, 80, 80, 255);
    rect(m, 40, 40, 60, 60, 0); // ثقب داخليّ ٤٠٠px
    const r = analyzeMask(m, W, H);
    expect(r.hasInternalHoles).toBe(true);
    expect(r.mode).toBe("FLATTEN");
    expect(r.reasons.some((x) => x.includes("ثقوب"))).toBe(true);
  });

  it("حواف مهترئة (شبه-شفّافة كثيرة) ⇒ FLATTEN", () => {
    const m = rect(blank(0), 20, 20, 80, 80, 128); // 3600 شبه-شفّاف
    rect(m, 35, 35, 65, 65, 255); // 900 معتم في القلب
    const r = analyzeMask(m, W, H);
    expect(r.softEdgeRatio).toBeGreaterThan(0.35);
    expect(r.mode).toBe("FLATTEN");
    expect(r.reasons.some((x) => x.includes("حواف"))).toBe(true);
  });

  it("منتج ضئيل (تحت الحدّ الأدنى) ⇒ FLATTEN", () => {
    const m = rect(blank(0), 48, 48, 52, 52, 255); // 16px
    const r = analyzeMask(m, W, H);
    expect(r.foregroundRatio).toBeLessThan(0.03);
    expect(r.mode).toBe("FLATTEN");
  });

  it("قناع يغطّي الإطار كلّه ⇒ FLATTEN + touchesFrame", () => {
    const r = analyzeMask(blank(255), W, H);
    expect(r.mode).toBe("FLATTEN");
    expect(r.touchesFrame).toBe(true);
  });

  it("forceFlatten (قرطاسية) ⇒ FLATTEN حتى لو كان القصّ نظيفاً", () => {
    const m = rect(blank(0), 30, 30, 70, 70, 255); // نظيف ⇒ لولا القسر لكان CUT
    const r = analyzeMask(m, W, H, { forceFlatten: true });
    expect(r.mode).toBe("FLATTEN");
    expect(r.reasons.some((x) => x.includes("قرطاسية"))).toBe(true);
  });

  it("منتج معتم يلامس الحدّ ⇒ touchesFrame=true (إشارة مراجعة، لا تُجبِر FLATTEN)", () => {
    const m = rect(blank(0), 0, 0, 40, 40, 255); // يلامس أعلى-يسار
    const r = analyzeMask(m, W, H);
    expect(r.touchesFrame).toBe(true);
    expect(r.mode).toBe("CUT"); // لا سبب FLATTEN آخر
  });

  it("يرفض قناعاً غير متسق مع الأبعاد", () => {
    expect(() => analyzeMask(new Uint8Array(10), W, H)).toThrow();
  });
});
