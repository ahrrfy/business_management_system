import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { allocateProportionally } from "../delivery/remittance";

/**
 * Codex #1012 P1 — توزيعُ نقد التوريد على الأسطر بمنهج largest-remainder: لا حصّةَ سالبة أبداً،
 * والمجموعُ يساوي الهدف تماماً. كان تقريبُ كلّ حصّةٍ مستقلّةً («الأخير يمتصّ الباقي») يُنتج حصّةً
 * أخيرةً سالبة حين يتجاوز مجموعُ السابقة الهدفَ ⇒ `cashReceived` سالبٌ يُخزَّن وقيودُ الموجب تتجاوز الإيصال.
 */
describe("allocateProportionally — largest-remainder بلا حصّةٍ سالبة (Codex #1012 P1)", () => {
  const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));

  it("العطبُ المُبلَّغ: 0.02 على أربعة أوزانٍ متساوية ⇒ لا سالب، والمجموع 0.02", () => {
    const out = allocateProportionally(new Decimal("0.02"), [1, 1, 1, 1].map((w) => new Decimal(w)));
    expect(out.every((x) => x.gte(0))).toBe(true);
    expect(sum(out).toFixed(2)).toBe("0.02");
    // largest-remainder: سنتّان للأوّلين (تعادلُ الكسور ⇒ الأصغرُ فهرساً).
    expect(out.map((x) => x.toFixed(2))).toEqual(["0.01", "0.01", "0.00", "0.00"]);
  });

  it("هدفٌ صحيحٌ بالدينار على ثلاثة أسطر متساوية ⇒ لا سالب، والمجموع مساوٍ تماماً", () => {
    const out = allocateProportionally(new Decimal("100"), [1, 1, 1].map((w) => new Decimal(w)));
    expect(out.every((x) => x.gte(0))).toBe(true);
    expect(sum(out).toFixed(2)).toBe("100.00");
    expect(out.map((x) => x.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
  });

  it("القسمةُ النظيفة تبقى نسبيّةً بالضبط", () => {
    const out = allocateProportionally(new Decimal("100"), [new Decimal("60"), new Decimal("40")]);
    expect(out.map((x) => x.toFixed(2))).toEqual(["60.00", "40.00"]);
  });

  it("أوزانٌ متفاوتة كثيرة: لا حصّةَ سالبة والمجموع = الهدف (منزلتان)", () => {
    const weights = [17, 3, 3, 3, 3, 3, 3, 3].map((w) => new Decimal(w));
    const out = allocateProportionally(new Decimal("1000.05"), weights);
    expect(out.every((x) => x.gte(0))).toBe(true);
    expect(sum(out).toFixed(2)).toBe("1000.05");
  });

  it("مجموع أوزانٍ صفريّ: الأخير يحمل الهدف كلّه (لا سالب لأنّ الهدف ≥ 0)", () => {
    const out = allocateProportionally(new Decimal("5"), [new Decimal(0), new Decimal(0)]);
    expect(out.map((x) => x.toFixed(2))).toEqual(["0.00", "5.00"]);
    expect(sum(out).toFixed(2)).toBe("5.00");
  });

  it("قائمةٌ فارغة ⇒ ناتجٌ فارغ", () => {
    expect(allocateProportionally(new Decimal("10"), [])).toEqual([]);
  });

  it("ثابتٌ عامّ: أيّ توزيعٍ لهدفٍ ≥ 0 على أوزانٍ ≥ 0 لا يُنتج سالباً ومجموعه = الهدف", () => {
    const cases: Array<[string, number[]]> = [
      ["7.77", [1, 2, 4]],
      ["0.03", [1, 1, 1, 1, 1]],
      ["999999.99", [5, 5, 5, 5, 5, 5, 5]],
      ["12.51", [100, 1]],
    ];
    for (const [target, ws] of cases) {
      const out = allocateProportionally(new Decimal(target), ws.map((w) => new Decimal(w)));
      expect(out.every((x) => x.gte(0)), `${target} / ${ws.join(",")}`).toBe(true);
      expect(sum(out).toFixed(2), `${target} / ${ws.join(",")}`).toBe(new Decimal(target).toFixed(2));
    }
  });
});
