import { describe, expect, it } from "vitest";
import { buildBarcodePdfFilename, buildBatchBarcodePdfFilename } from "./barcodePdf";

describe("client/src/lib/printing/barcodePdf", () => {
  it("يُنتج اسم ملف PDF باسم المنتج والباركود للاستخدام المباشر في التنزيل", () => {
    const filename = buildBarcodePdfFilename({
      productName: "كراس رسم مدرسي 24 ورقة",
      unitName: "درزن",
      barcode: "2007778889991",
    });
    expect(filename).toBe("كراس رسم مدرسي 24 ورقة - درزن - 2007778889991.pdf");
  });

  it("يُسقط كلمة قطعة من التسمية اختصاراً للوضوح", () => {
    const filename = buildBarcodePdfFilename({
      productName: "قلم جاف أزرق",
      unitName: "قطعة",
      barcode: "2001112223334",
    });
    expect(filename).toBe("قلم جاف أزرق - 2001112223334.pdf");
  });

  it("يُنتج اسم ملف متوافق لدفعة ملصقات PDF لقائمة الطباعة", () => {
    const filename = buildBatchBarcodePdfFilename({
      totalCount: 50,
      itemCount: 4,
      dateStr: "2026-10-02",
    });
    expect(filename).toBe("ملصقات باركود - 50 ملصق (4 صنف) - 2026-10-02.pdf");
  });
});

