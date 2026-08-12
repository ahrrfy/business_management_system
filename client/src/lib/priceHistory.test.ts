import { describe, expect, it } from "vitest";
import { formatHistoryPrice, toPriceHistoryDisplay } from "./priceHistory";

describe("price history display", () => {
  it("ينسّق السعر مع إبقاء الصفر وتمييز السعر الأول", () => {
    expect(formatHistoryPrice(null)).toBe("—");
    expect(formatHistoryPrice("0.00")).toBe("0");
    expect(formatHistoryPrice("12500.50")).toBe("12,500.5");
  });

  it("يعرض اسم المنفّذ والموجة والسبب عند توفرها", () => {
    expect(toPriceHistoryDisplay({
      oldPrice: "1000.00",
      newPrice: "1250.00",
      priceTier: "WHOLESALE",
      reason: "ارتفاع كلفة المورد",
      waveId: 8,
      waveName: "تحديث آب",
      actorUserId: 4,
      actorName: "مدير المنتجات",
    })).toEqual({
      oldPrice: "1,000",
      newPrice: "1,250",
      tier: "جملة",
      actor: "مدير المنتجات",
      source: "تحديث آب",
      reason: "ارتفاع كلفة المورد",
    });
  });

  it("يستخدم بدائل صريحة إذا حُذف المستخدم أو اسم الموجة", () => {
    const display = toPriceHistoryDisplay({
      oldPrice: null,
      newPrice: "500",
      priceTier: "RETAIL",
      waveId: 12,
      actorUserId: 9,
    });
    expect(display.actor).toBe("مستخدم #9");
    expect(display.source).toBe("موجة #12");
    expect(display.reason).toBe("—");
  });
});
