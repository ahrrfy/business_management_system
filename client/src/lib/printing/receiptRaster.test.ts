// اختبارات لفّ نص أسماء الأصناف في الراسم الحراري المُعلَّم (الجزء النقي — بلا Canvas حقيقي)
import { describe, expect, it } from "vitest";
import { wrapLines } from "./receiptRaster";

/** قياس زائف: عرض كل محرف = 10px ⇒ maxW=100 يستوعب 10 محارف */
const ctx = { measureText: (s: string) => ({ width: s.length * 10 }) };

describe("wrapLines — لفّ أسماء الأصناف", () => {
  it("نص قصير يبقى سطراً واحداً كما هو", () => {
    expect(wrapLines(ctx, "قلم أزرق", 200)).toEqual(["قلم أزرق"]);
  });

  it("نص أطول من العرض يلتفّ على سطرين دون فقدان كلمات", () => {
    const lines = wrapLines(ctx, "دفتر مدرسي ٩٦ ورقة", 100);
    expect(lines.length).toBe(2);
    expect(lines.join(" ")).toBe("دفتر مدرسي ٩٦ ورقة");
    for (const l of lines) expect(ctx.measureText(l).width).toBeLessThanOrEqual(100);
  });

  it("الفائض عن سطرين يُقصّ ويُختم آخر سطر بـ«…»", () => {
    const lines = wrapLines(ctx, "اسم منتج طويل جداً يتجاوز السطرين المسموحين في عمود الصنف", 100);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith("…")).toBe(true);
    for (const l of lines) expect(ctx.measureText(l).width).toBeLessThanOrEqual(100);
  });

  it("كلمة واحدة أعرض من العمود تُقصّ بـ«…» ضمن العرض", () => {
    const lines = wrapLines(ctx, "كلمةواحدةطويلةجداًبلامسافات", 100);
    expect(lines.length).toBe(1);
    expect(lines[0].endsWith("…")).toBe(true);
    expect(ctx.measureText(lines[0]).width).toBeLessThanOrEqual(100);
  });

  it("نص فارغ يعيد سطراً فارغاً واحداً (لا ينهار)", () => {
    expect(wrapLines(ctx, "", 100)).toEqual([""]);
  });
});
