// اختبارات مساعِدات قسم تسليم النقد (منطق السلامة: منع إسقاط تسليمٍ ناقصٍ صامتاً + دقّة decimal).
import { describe, expect, it } from "vitest";
import { buildHandoverPayload, handoverIncomplete, type ShiftHandoverValue } from "../ShiftHandoverSection";

const v = (o: Partial<ShiftHandoverValue>): ShiftHandoverValue => ({
  amount: "",
  handoverTo: null,
  notes: "",
  ...o,
});

describe("buildHandoverPayload", () => {
  it("فارغ ⇒ undefined (لا تسليم)", () => {
    expect(buildHandoverPayload(v({}))).toBeUndefined();
  });

  it("مبلغ بلا مستلِم ⇒ undefined (لا يُرسَل حتى لا يُرفَض/يُسقَط)", () => {
    expect(buildHandoverPayload(v({ amount: "200" }))).toBeUndefined();
  });

  it("مبلغ صفر مع مستلِم ⇒ undefined (غير موجب)", () => {
    expect(buildHandoverPayload(v({ amount: "0", handoverTo: 2 }))).toBeUndefined();
  });

  it("مبلغ موجب + مستلِم ⇒ حمولة بمبلغ 2dp وملاحظة undefined", () => {
    expect(buildHandoverPayload(v({ amount: "200", handoverTo: 2 }))).toEqual({
      amount: "200.00",
      handoverTo: 2,
      notes: undefined,
    });
  });

  it("مبلغ عشريّ ⇒ يُقرَّب/يُنسَّق إلى منزلتين (§٥ decimal لا Number)", () => {
    expect(buildHandoverPayload(v({ amount: "150.5", handoverTo: 3 }))?.amount).toBe("150.50");
    expect(buildHandoverPayload(v({ amount: "99.999", handoverTo: 3 }))?.amount).toBe("100.00");
  });

  it("ملاحظة تُقلَّم؛ فراغٌ محض ⇒ undefined", () => {
    expect(buildHandoverPayload(v({ amount: "10", handoverTo: 2, notes: "  " }))?.notes).toBeUndefined();
    expect(buildHandoverPayload(v({ amount: "10", handoverTo: 2, notes: " للخزينة " }))?.notes).toBe("للخزينة");
  });
});

describe("handoverIncomplete", () => {
  it("فارغ ⇒ false (لا يحجب الإغلاق)", () => {
    expect(handoverIncomplete(v({}))).toBe(false);
  });

  it("مبلغ موجب بلا مستلِم ⇒ true (يحجب الإغلاق كي لا يُسقَط التسليم صامتاً)", () => {
    expect(handoverIncomplete(v({ amount: "50" }))).toBe(true);
  });

  it("مبلغ موجب + مستلِم ⇒ false", () => {
    expect(handoverIncomplete(v({ amount: "50", handoverTo: 2 }))).toBe(false);
  });

  it("مبلغ صفر بلا مستلِم ⇒ false", () => {
    expect(handoverIncomplete(v({ amount: "0" }))).toBe(false);
  });
});
