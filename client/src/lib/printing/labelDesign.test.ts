import { describe, expect, it } from "vitest";
import { labelDocHtml, snappedBarcodeWidthMm } from "./labelDesign";

// تثبيت عرض الباركود على شبكة نقاط الطابعة (203dpi = 8 نقاط/مم): عرض الوحدة = نقاط كاملة
// ⇒ لا تمديد كسريّاً يقرّبه تعريف الطابعة قضباناً متفاوتة فيختلّ ميزان النسب (سبب المسح المتقطّع).
describe("snappedBarcodeWidthMm", () => {
  it("EAN-13 (113 وحدة) على ملصق 35مم ⇒ نقطتان/وحدة = 28.25مم (X=0.25مم قابل للمسح)", () => {
    expect(snappedBarcodeWidthMm(113, 35)).toBe(28.25);
  });

  it("Code128 داخلي (154 وحدة) على 35مم ⇒ نقطة/وحدة = 19.25مم (قضبان متساوية حادّة)", () => {
    expect(snappedBarcodeWidthMm(154, 35)).toBe(19.25);
  });

  it("على 50مم يرتفع EAN-13 إلى ٣ نقاط/وحدة = 42.375مم", () => {
    expect(snappedBarcodeWidthMm(113, 50)).toBe(42.375);
  });

  it("رمز أعرض من الملصق حتى بنقطة/وحدة ⇒ 0 (يتكفّل المستدعي بالتمدّد الكامل)", () => {
    expect(snappedBarcodeWidthMm(400, 35)).toBe(0);
  });
});

describe("labelDocHtml — كتلة الباركود المثبَّتة", () => {
  const item = {
    name: "قلم حبر أزرق",
    barcode: "4006381333931",
    price: "250",
    sku: "PN-1",
  };

  it("يلفّ قضبان EAN-13 بحاويةٍ بعرضٍ فيزيائيٍّ مثبَّت على ملصق 35×15", () => {
    const html = labelDocHtml([item], { widthMm: 35, heightMm: 15 });
    expect(html).toContain('class="lbl-bcs" style="width:28.25mm"');
  });

  it("العرض المثبَّت يتبع مقاس الملصق (50×25 ⇒ 42.375مم)", () => {
    const html = labelDocHtml([item], { widthMm: 50, heightMm: 25 });
    expect(html).toContain('class="lbl-bcs" style="width:42.375mm"');
  });

  it("الرمز الداخليّ ALR يُرمَّز Code128 بعرضٍ مثبَّتٍ أيضاً", () => {
    const html = labelDocHtml([{ ...item, barcode: "ALR0000042" }], {
      widthMm: 35,
      heightMm: 15,
    });
    // ALR0000042 = 11 رمزاً ⇒ 134 وحدة + هدوء 20 = 154 ⇒ نقطة/وحدة على 35مم = 19.25مم.
    expect(html).toContain('class="lbl-bcs" style="width:19.25mm"');
  });

  it("30×10مم يطبع القضبان وحدها بارتفاع 9مم ووحدة بعرض نقطتين دون النصوص", () => {
    const html = labelDocHtml([{
      ...item,
      basePrice: "1000",
      tierLabel: "جملة",
      attrs: { baseName: item.name, tags: ["أزرق"], colorHex: "#0000ff" },
    }], { widthMm: 30, heightMm: 10 }, { showName: true, showPrice: true });

    expect(html).toContain("@page{size:30mm 10mm;margin:0}");
    expect(html).toContain("padding:0.5mm 0.5mm");
    expect(html).toContain('class="lbl-bc" style="height:9mm"');
    expect(html).toContain('class="lbl-bcs" style="width:28.25mm"');
    const body = html.slice(html.indexOf("<body"));
    expect(body).not.toMatch(/class="lbl-(?:nm|at|bn|bt|sk|pr|tr|ob)"/);
    expect(body).not.toContain("<text");
    expect(body).not.toContain(item.name);
    expect(body).not.toContain(item.sku);
  });
});
