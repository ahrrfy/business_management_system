// قاعدة موجة التسعير — اختبار منطقيّ نقيّ (بلا قاعدة بيانات).
// مُسجَّل في `vitest.unit.config.ts`؛ بدون التسجيل لا يُشغَّل أبداً (CLAUDE.md §٣).
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { roundCashIQD } from "../server/services/money";
import {
  DEFAULT_PRICE_ROUND_DENOM,
  MIN_PRICE,
  applyPriceWaveRule,
  isPercentChange,
  marginPct,
  roundToDenom,
} from "./priceWaveRule";

describe("roundToDenom — تكافؤٌ مع سياسة النقد", () => {
  it("لا يقرّب حين denom صفر أو غير صالح", () => {
    expect(roundToDenom(new Decimal("1522.50"), 0).toFixed(2)).toBe("1522.50");
    expect(roundToDenom(new Decimal("1522.50"), null).toFixed(2)).toBe(
      "1522.50",
    );
    expect(roundToDenom(new Decimal("1522.50"), -250).toFixed(2)).toBe(
      "1522.50",
    );
    expect(roundToDenom(new Decimal("1522.50"), 2.5).toFixed(2)).toBe(
      "1522.50",
    );
  });

  it("HALF_UP لأقرب مضاعف: ١٥٢٢٫٥ ⇒ ١٥٠٠ · ١٦٣٠ ⇒ ١٧٥٠ · ١٢٥ ⇒ ٢٥٠", () => {
    expect(roundToDenom(new Decimal("1522.50"), 250).toFixed(0)).toBe("1500");
    expect(roundToDenom(new Decimal("1630"), 250).toFixed(0)).toBe("1750");
    expect(roundToDenom(new Decimal("125"), 250).toFixed(0)).toBe("250");
    expect(roundToDenom(new Decimal("124.99"), 250).toFixed(0)).toBe("0");
  });

  it("⭐ يطابق `roundCashIQD` على كل القيم — منعُ انجرافِ سياستَي تقريبٍ متوازيتَين", () => {
    for (const denom of [250, 500, 1000]) {
      for (let v = 0; v <= 6000; v += 37) {
        const mine = roundToDenom(new Decimal(v), denom).toFixed(2);
        const cash = roundCashIQD(v, denom).toFixed(2);
        expect(`${v}@${denom}=${mine}`).toBe(`${v}@${denom}=${cash}`);
      }
    }
  });
});

describe("applyPriceWaveRule — الأنواع الخمسة", () => {
  const noRound = { roundToDenom: 0 };

  it("رفع/تخفيض بنسبة", () => {
    expect(
      applyPriceWaveRule("1000", "400", {
        changeType: "INCREASE_PERCENT",
        changeValue: "10",
        ...noRound,
      }).newPrice,
    ).toBe("1100.00");
    expect(
      applyPriceWaveRule("1000", "400", {
        changeType: "DECREASE_PERCENT",
        changeValue: "10",
        ...noRound,
      }).newPrice,
    ).toBe("900.00");
  });

  it("إضافة/طرح مبلغ ثابت", () => {
    expect(
      applyPriceWaveRule("1000", "400", {
        changeType: "INCREASE_AMOUNT",
        changeValue: "250",
        ...noRound,
      }).newPrice,
    ).toBe("1250.00");
    expect(
      applyPriceWaveRule("1000", "400", {
        changeType: "DECREASE_AMOUNT",
        changeValue: "250",
        ...noRound,
      }).newPrice,
    ).toBe("750.00");
  });

  it("SET_MARGIN يُشتقّ من تكلفة **الوحدة** الممرَّرة لا من أيّ تكلفة أخرى", () => {
    // درزن: تكلفة الأساس ١٠٠٠ × معامل ١٢ = ١٢٠٠٠ ⇒ هامش ٢٥٪ فوق التكلفة ⇒ ١٥٠٠٠.
    const r = applyPriceWaveRule("9000", "12000", {
      changeType: "SET_MARGIN",
      changeValue: "25",
      ...noRound,
    });
    expect(r.newPrice).toBe("15000.00");
  });

  it("SET_MARGIN بلا تكلفة ⇒ سقوطٌ **مُعلَّل** لا تخطٍّ صامت", () => {
    const plain = applyPriceWaveRule("1000", null, {
      changeType: "SET_MARGIN",
      changeValue: "25",
    });
    expect(plain.newPrice).toBeNull();
    expect(plain.skipReason).toBe("NO_COST");

    const bundle = applyPriceWaveRule(
      "1000",
      "0",
      { changeType: "SET_MARGIN", changeValue: "25" },
      true,
    );
    expect(bundle.skipReason).toBe("BUNDLE_COST_UNRESOLVED");
  });
});

describe("التقريب داخل القاعدة — قرار المالك ٢٠/٨/٢٦", () => {
  it("الافتراضيّ في الواجهة ٢٥٠: ‎1,450 + ‎5٪ = ‎1,522.50 ⇒ ‎1,500", () => {
    expect(DEFAULT_PRICE_ROUND_DENOM).toBe(250);
    const r = applyPriceWaveRule("1450", "900", {
      changeType: "INCREASE_PERCENT",
      changeValue: "5",
      roundToDenom: DEFAULT_PRICE_ROUND_DENOM,
    });
    expect(r.newPrice).toBe("1500.00");
    expect(r.rounded).toBe(true);
  });

  it("وبلا تقريب تبقى ‎1,522.50 (الخدمة لا تفترض تقريباً)", () => {
    const r = applyPriceWaveRule("1450", "900", {
      changeType: "INCREASE_PERCENT",
      changeValue: "5",
    });
    expect(r.newPrice).toBe("1522.50");
    expect(r.rounded).toBe(false);
  });

  it("تغييرٌ يبتلعه التقريب ⇒ يسقط الصفّ بسبب UNCHANGED (لا سطرٌ وهميّ في المعاينة)", () => {
    // رفعٌ ٢٪ على ‎1,000 = ‎1,020 ⇒ تقريبٌ لأقرب ٢٥٠ يعيده إلى ‎1,000 نفسها.
    const r = applyPriceWaveRule("1000", "600", {
      changeType: "INCREASE_PERCENT",
      changeValue: "2",
      roundToDenom: 250,
    });
    expect(r.newPrice).toBeNull();
    expect(r.skipReason).toBe("UNCHANGED");
  });
});

describe("W2 — الأرضية المطلقة", () => {
  it("تخفيضٌ ٩٩٪ يُقصّ إلى 0.01 لا صفر", () => {
    const r = applyPriceWaveRule("1000", "400", {
      changeType: "DECREASE_PERCENT",
      changeValue: "99",
      roundToDenom: 0,
    });
    expect(r.newPrice).toBe("10.00");

    const deep = applyPriceWaveRule("1", "0.5", {
      changeType: "DECREASE_PERCENT",
      changeValue: "99.9",
      roundToDenom: 0,
    });
    expect(deep.newPrice).toBe(MIN_PRICE === "0.01" ? "0.01" : MIN_PRICE);
    expect(deep.clampedMin).toBe(true);
  });

  it("التقريب لا يُنتج صفراً: ‎100 بتقريب ٢٥٠ ⇒ يُقصّ إلى الأرضية", () => {
    const r = applyPriceWaveRule("1000", null, {
      changeType: "DECREASE_AMOUNT",
      changeValue: "900",
      roundToDenom: 250,
    });
    expect(r.newPrice).toBe("0.01");
    expect(r.clampedMin).toBe(true);
  });
});

describe("marginPct — لا هامش ١٠٠٪ كاذب", () => {
  it("يحسب الهامش على المبيع", () => {
    expect(marginPct("1000", "600")).toBe(40);
  });

  it("تكلفةٌ صفر/مجهولة ⇒ null (حالة البكج قبل حلّ وصفته)", () => {
    expect(marginPct("1000", "0")).toBeNull();
    expect(marginPct("1000", null)).toBeNull();
  });
});

describe("isPercentChange", () => {
  it("النسب الثلاث فقط", () => {
    expect(isPercentChange("INCREASE_PERCENT")).toBe(true);
    expect(isPercentChange("DECREASE_PERCENT")).toBe(true);
    expect(isPercentChange("SET_MARGIN")).toBe(true);
    expect(isPercentChange("INCREASE_AMOUNT")).toBe(false);
    expect(isPercentChange("DECREASE_AMOUNT")).toBe(false);
  });
});
