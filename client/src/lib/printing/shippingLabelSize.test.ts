import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHIPPING_LABEL_SIZE,
  SHIPPING_LABEL_PRESETS,
  parseShippingLabelSize,
  shippingLabelSizeKey,
} from "./shippingLabelSize";
import { shippingLabelHtml } from "./shippingLabel";

describe("قياس ملصق الشحن", () => {
  it("الافتراضي 80×120مم (قرار المالك 13/7)", () => {
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

  it("يرفض القياس الأفقي العشوائي ويقبل المقاسين المعتمدين (120x80 و80x50) والمربّع", () => {
    expect(parseShippingLabelSize("250x40")).toBeNull(); // أفقي مسطّح غير معتمد
    expect(parseShippingLabelSize("150x60")).toBeNull(); // أفقي عشوائي غير معتمد
    expect(parseShippingLabelSize("120x80")).toEqual({ widthMm: 120, heightMm: 80 }); // عرضي معتمد
    expect(parseShippingLabelSize("80x50")).toEqual({ widthMm: 80, heightMm: 50 }); // مدمج معتمد
    expect(parseShippingLabelSize("100x100")).toEqual({ widthMm: 100, heightMm: 100 }); // مربّع مُثبَت
  });

  it("يعرّف القوالب الستة بأرقام لاتينية 0-9 حصراً", () => {
    expect(SHIPPING_LABEL_PRESETS.map((p) => p.key)).toEqual([
      "80x120",
      "100x150",
      "120x80",
      "80x50",
      "100x100",
      "80x100",
    ]);
    for (const preset of SHIPPING_LABEL_PRESETS) {
      expect(preset.label).not.toMatch(/[٠-٩]/);
      expect(parseShippingLabelSize(preset.key)).toEqual(preset.size);
    }
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

  it("الافتراضي (80×120): @page بالقياس الصحيح وحاوية بأبعاد مباشرة", async () => {
    const html = await shippingLabelHtml(order);
    expect(html).toContain("@page{size:80mm 120mm;margin:0mm !important}");
    expect(html).toContain("width:80mm");
    expect(html).toContain("height:120mm"); // html,body height matches label
    // الحاوية .lbl-container تأخذ أبعاد الملصق مباشرة بلا transform
    expect(html).toContain("lbl-container");
  });

  it("قياس 4×6 (100×150): أبعاد حاوية مطابقة", async () => {
    const html = await shippingLabelHtml(order, { widthMm: 100, heightMm: 150 });
    expect(html).toContain("@page{size:100mm 150mm;margin:0mm !important}");
    expect(html).toContain("width:100mm");
    expect(html).toContain("height:150mm");
  });

  it("قياس عرضي (120×80) ومخصّص مربّع (100×100): الحاوية تتكيّف", async () => {
    const htmlLandscape = await shippingLabelHtml(order, { widthMm: 120, heightMm: 80 });
    expect(htmlLandscape).toContain("@page{size:120mm 80mm;margin:0mm !important}");
    expect(htmlLandscape).toContain("grid-template-columns:1fr 1fr");

    const htmlSquare = await shippingLabelHtml(order, { widthMm: 100, heightMm: 100 });
    expect(htmlSquare).toContain("@page{size:100mm 100mm;margin:0mm !important}");
    expect(htmlSquare).toContain("width:100mm");
    expect(htmlSquare).toContain("height:100mm");
  });

  it("القياس المدمج (80×50): باركود بعرض صف كامل دون تشويه ودون تفقيط مطوّل", async () => {
    const htmlCompact = await shippingLabelHtml(
      { ...order, qrUrl: "https://alarabiya.online/verify?ref=ON-2026-000123" },
      { widthMm: 80, heightMm: 50 },
    );
    expect(htmlCompact).toContain("@page{size:80mm 50mm;margin:0mm !important}");
    expect(htmlCompact).toContain('colspan="2"');
    expect(htmlCompact).toContain("bc-compact-svg");
    expect(htmlCompact).not.toContain('preserveAspectRatio="none"');
    expect(htmlCompact).not.toContain("خمسة وأربعون ألف");
  });

  it("يخفي خلية QR وعبارة تتبع الشحنة عند غياب هدف QR", async () => {
    const noQrOrder = { ...order, orderNumber: "CN-2026-000999", qrUrl: null };
    const htmlPortrait = await shippingLabelHtml(noQrOrder, { widthMm: 80, heightMm: 120 });
    expect(htmlPortrait).not.toContain("تتبع الشحنة");
    expect(htmlPortrait).not.toContain('class="qr-svg"');

    const htmlLandscape = await shippingLabelHtml(noQrOrder, { widthMm: 120, heightMm: 80 });
    expect(htmlLandscape).not.toContain("تتبع الشحنة");
    expect(htmlLandscape).not.toContain('class="qr-svg"');
  });

  it("مضمون الملصق ثابت بأي قياس: مستلِم/COD/باركود/محتويات", async () => {
    const html = await shippingLabelHtml(order, { widthMm: 80, heightMm: 100 });
    expect(html).toContain("زبون تجريبي");
    expect(html).toContain("ON-2026-000123");
    expect(html).toContain("الدفع عند الاستلام");
    expect(html).toContain("بغداد"); // baghdad ⇒ اسم المحافظة
    expect(html).toContain("دفتر A4 (درزن)");
    expect(html).toContain("×2");
    expect(html).toContain("مندوب الكرخ");
  });

  it("سعة الأصناف تتكيف ديناميكياً مع الارتفاع المتاح ولا تُقفل على صنفين", async () => {
    const multiItemOrder = {
      ...order,
      items: [
        { productName: "صنف 1", unitName: "قطعة", quantity: "1" },
        { productName: "صنف 2", unitName: "قطعة", quantity: "1" },
        { productName: "صنف 3", unitName: "قطعة", quantity: "1" },
        { productName: "صنف 4", unitName: "قطعة", quantity: "1" },
        { productName: "صنف 5", unitName: "قطعة", quantity: "1" },
      ],
    };

    // قياس 100×150 يستوعب كافة الأصناف الخمسة مباشرة دون اختصار
    const html150 = await shippingLabelHtml(multiItemOrder, { widthMm: 100, heightMm: 150 });
    expect(html150).toContain("صنف 1");
    expect(html150).toContain("صنف 5");
    expect(html150).not.toContain("صنف إضافي في الفاتورة المرفقة");

    // قياس 80×120 يستوعب حتى 6 أصناف
    const html120 = await shippingLabelHtml(multiItemOrder, { widthMm: 80, heightMm: 120 });
    expect(html120).toContain("صنف 1");
    expect(html120).toContain("صنف 5");
    expect(html120).not.toContain("صنف إضافي في الفاتورة المرفقة");
  });
});
