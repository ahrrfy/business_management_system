import { describe, expect, it } from "vitest";
import {
  REFUND_RAILS,
  REFUND_RAIL_HINT,
  REFUND_RAIL_LABEL,
  refundRailIsImmediate,
  refundRailNeedsReference,
  refundRailNeedsShift,
  refundRailReceiptShape,
  type RefundRail,
} from "./refundRail";

describe("refundRailReceiptShape — الخريطةُ الماليّة الحاكمة", () => {
  /**
   * ⭐ هذه الخريطةُ تقرّر **من أيّ حسابٍ يخرج المال**: `CASH+DRAWER ⇒ CASH`،
   * `CASH+TREASURY ⇒ TREASURY_CASH`، `CARD ⇒ CARD_BANK` (`paymentAssetRole`).
   * خطأُ حرفٍ هنا يُخرج ديناراً من حسابٍ لم يخرج منه فعلاً — فتُثبَّت صراحةً.
   */
  it("الدرج: نقدٌ من دلو الدرج", () => {
    expect(refundRailReceiptShape("DRAWER")).toEqual({ paymentMethod: "CASH", cashBucket: "DRAWER" });
  });

  it("الخزينة: نقدٌ من دلو الخزينة — لا يمسّ درجاً ولا تسويةَ وردية", () => {
    expect(refundRailReceiptShape("TREASURY")).toEqual({ paymentMethod: "CASH", cashBucket: "TREASURY" });
  });

  it("البطاقة: بلا دلوِ نقدٍ إطلاقاً (cashBucket = NULL)", () => {
    // ثابتُ §٦: غيرُ النقد `cashBucket=NULL` ⇒ لا يَمسّ درج الكاشير ولا expectedCash.
    expect(refundRailReceiptShape("CARD")).toEqual({ paymentMethod: "CARD", cashBucket: null });
  });
});

describe("خصائصُ الروافد — كلٌّ يلزمه ما يخصّه", () => {
  it("الدرجُ وحده يلزمه تحديدُ وردية", () => {
    expect(refundRailNeedsShift("DRAWER")).toBe(true);
    expect(refundRailNeedsShift("TREASURY")).toBe(false);
    expect(refundRailNeedsShift("CARD")).toBe(false);
  });

  it("البطاقةُ وحدها تلزمها مرجعُ تنفيذٍ خارجيّ", () => {
    expect(refundRailNeedsReference("CARD")).toBe(true);
    expect(refundRailNeedsReference("DRAWER")).toBe(false);
    expect(refundRailNeedsReference("TREASURY")).toBe(false);
  });

  /**
   * ⭐ الفرقُ الذي يحمي المال: النقديّان يخرجان فوراً (مكتمل/معتمَد)، والبطاقةُ **معلّقة**
   * حتى يُنفَّذ الاستردادُ على الجهاز ويُقرّه المالك — فلا قيدَ دفعٍ ولا دينارٌ قبل ذلك.
   */
  it("⭐ النقديّان فوريّان والبطاقةُ معلّقةٌ باعتماد", () => {
    expect(refundRailIsImmediate("DRAWER")).toBe(true);
    expect(refundRailIsImmediate("TREASURY")).toBe(true);
    expect(refundRailIsImmediate("CARD")).toBe(false);
  });

  it("الرافدُ المعلّقُ هو وحدَه الذي يلزمه مرجع — لا تتفكّك الخاصّيتان", () => {
    for (const rail of REFUND_RAILS) {
      expect(refundRailNeedsReference(rail)).toBe(!refundRailIsImmediate(rail));
    }
  });
});

describe("القاموس — مصدرٌ واحد بلا ثغرات", () => {
  it("لكلّ رافدٍ تسميةٌ وشرحُ أثر", () => {
    for (const rail of REFUND_RAILS) {
      expect(REFUND_RAIL_LABEL[rail]?.length).toBeGreaterThan(0);
      expect(REFUND_RAIL_HINT[rail]?.length).toBeGreaterThan(0);
    }
  });

  it("لا رافدَ زائدٌ في القاموسين (يُمسك إضافةً بلا تسمية)", () => {
    expect(Object.keys(REFUND_RAIL_LABEL).sort()).toEqual([...REFUND_RAILS].sort());
    expect(Object.keys(REFUND_RAIL_HINT).sort()).toEqual([...REFUND_RAILS].sort());
  });

  it("الشرحُ يذكر أثرَ كلّ رافد بما يميّزه", () => {
    expect(REFUND_RAIL_HINT.DRAWER).toContain("درج");
    expect(REFUND_RAIL_HINT.TREASURY).toContain("لا يمسّ أيّ درج");
    expect(REFUND_RAIL_HINT.CARD).toContain("لا يخرج مال");
  });
});

describe("سلامةُ الاتّحاد", () => {
  it("ثلاثةُ روافدَ لا رابع — أيُّ إضافةٍ تكسر هذا عمداً", () => {
    const rails: RefundRail[] = [...REFUND_RAILS];
    expect(rails).toEqual(["DRAWER", "TREASURY", "CARD"]);
  });
});
