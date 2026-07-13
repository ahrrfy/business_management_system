import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHIPPING_LABEL_SIZE,
  parseShippingLabelSize,
  shippingLabelSizeKey,
} from "./shippingLabelSize";
import { shippingLabelHtml } from "./shippingLabel";

describe("قياس ملصق الشحن", () => {
  it("الافتراضي ٨٠×١٢٠مم (قرار المالك ١٣/٧)", () => {
    expect(DEFAULT_SHIPPING_LABEL_SIZE).toEqual({ widthMm: 80, heightMm: 120 });
  });

  it("يفسّر الصيغ المقبولة: لاتيني/عربي، x/×/*، بمسافات", () => {
    expect(parseShippingLabelSize("80x120")).toEqual({ widthMm: 80, heightMm: 120 });
    expect(parseShippingLabelSize("100×150")).toEqual({ widthMm: 100, heightMm: 150 });
    expect(parseShippingLabelSize("90 * 130")).toEqual({ widthMm: 90, heightMm: 130 });
    expect(parseShippingLabelSize("٨٠×١٢٠")).toEqual({ widthMm: 80, heightMm: 120 });
  });

  it("يرفض ما خرج عن الحدود (40–250مم) أو الصيغ المعطوبة", () => {
    expect(parseShippingLabelSize("30x120")).toBeNull(); // أضيق من الحدّ
    expect(parseShippingLabelSize("80x300")).toBeNull(); // أطول من الحدّ
    expect(parseShippingLabelSize("80")).toBeNull();
    expect(parseShippingLabelSize("axb")).toBeNull();
    expect(parseShippingLabelSize("")).toBeNull();
    expect(parseShippingLabelSize("80x120x40")).toBeNull();
  });

  it("يرفض القياس الأفقي (ارتفاع < عرض) — يقصّ التذييل (Codex P2 على PR #185)، ويقبل المربّع", () => {
    expect(parseShippingLabelSize("250x40")).toBeNull(); // أفقي مسطّح — كان يمرّ ويُقتصّ
    expect(parseShippingLabelSize("120x80")).toBeNull(); // مقلوب
    expect(parseShippingLabelSize("100x100")).toEqual({ widthMm: 100, heightMm: 100 }); // مربّع مُثبَت
  });

  it("مفتاح التخزين ذهاب-إياب", () => {
    const s = { widthMm: 95, heightMm: 145 };
    expect(parseShippingLabelSize(shippingLabelSizeKey(s))).toEqual(s);
  });
});

describe("HTML ملصق الشحن بقياس متغيّر", () => {
  const order = {
    orderNumber: "ON-2026-000123",
    customerName: "زبون تجريبي",
    customerPhone: "+9647701234567",
    governorate: "baghdad",
    addressText: "حي المنصور، شارع 14 رمضان",
    total: "45000",
    deliveryPartyName: "مندوب الكرخ",
    createdAt: new Date("2026-07-13T10:00:00Z"),
    items: [{ productName: "دفتر A4", unitName: "درزن", quantity: "2" }],
  };

  it("الافتراضي (٨٠×١٢٠): @page بالقياس الصحيح ومعامل تحجيم 0.8", async () => {
    const html = await shippingLabelHtml(order);
    expect(html).toContain("@page{size:80mm 120mm;margin:0}");
    expect(html).toContain("width:80mm;height:120mm");
    expect(html).toContain("transform:scale(0.8)");
    // الارتفاع الداخلي = 120 / 0.8 = 150مم (اللوحة المرجعية تملأ الملصق بعد التحجيم)
    expect(html).toContain("height:150.000mm");
  });

  it("قياس 4×6 (١٠٠×١٥٠): معامل 1 وارتفاع داخلي 150مم", async () => {
    const html = await shippingLabelHtml(order, { widthMm: 100, heightMm: 150 });
    expect(html).toContain("@page{size:100mm 150mm;margin:0}");
    expect(html).toContain("transform:scale(1)");
    expect(html).toContain("height:150.000mm");
  });

  it("قياس مخصّص بنسبة مختلفة (١٠٠×١٠٠): الفرق يمتصّه شريط الباركود المرن", async () => {
    const html = await shippingLabelHtml(order, { widthMm: 100, heightMm: 100 });
    expect(html).toContain("@page{size:100mm 100mm;margin:0}");
    expect(html).toContain("height:100.000mm");
  });

  it("مضمون الملصق ثابت بأي قياس: مستلِم/COD/باركود/محتويات", async () => {
    const html = await shippingLabelHtml(order, { widthMm: 80, heightMm: 100 });
    expect(html).toContain("زبون تجريبي");
    expect(html).toContain("ON-2026-000123");
    expect(html).toContain("الدفع عند الاستلام");
    expect(html).toContain("بغداد"); // baghdad ⇒ اسم المحافظة
    expect(html).toContain("دفتر A4 (درزن) ×2");
    expect(html).toContain("مندوب الكرخ");
  });
});
