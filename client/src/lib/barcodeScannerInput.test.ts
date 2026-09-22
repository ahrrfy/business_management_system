import { describe, expect, it } from "vitest";
import { normalizeBarcodeScannerInput, normalizeKnownSystemBarcode } from "./barcodeScannerInput";
import { parseScan } from "./scanRouter";
import { resolveShippingLabelQrTarget } from "./printing/shippingLabel";

describe("normalizeBarcodeScannerInput", () => {
  it("يصحح رقم الفاتورة المقروء تحت تخطيط لوحة المفاتيح العربية", () => {
    expect(normalizeBarcodeScannerInput("÷آ{-1-20260806-00068")).toBe("INV-1-20260806-00068");
  });

  it("يصحح أحرف قارئ المنتجات والأرقام العربية-الهندية", () => {
    expect(normalizeBarcodeScannerInput("شمق٠٠١٢٣")).toBe("alr00123");
  });

  it("يبقي ASCII الصحيح كما هو", () => {
    expect(normalizeBarcodeScannerInput("INV-1-20260806-00068")).toBe("INV-1-20260806-00068");
    expect(normalizeBarcodeScannerInput("ABC/12[3]{4}")).toBe("ABC/12[3]{4}");
  });
});

describe("normalizeKnownSystemBarcode", () => {
  it("يصحح بادئات النظام المعروفة", () => {
    expect(normalizeKnownSystemBarcode("÷آ{-1-20260806-00068")).toBe("INV-1-20260806-00068");
  });

  it("لا يحول البحث العربي اليدوي", () => {
    expect(normalizeKnownSystemBarcode("قلم ازرق")).toBe("قلم ازرق");
    expect(normalizeKnownSystemBarcode("قلم ازرق ")).toBe("قلم ازرق ");
    expect(normalizeKnownSystemBarcode("عمار السلامي ")).toBe("عمار السلامي ");
  });
});

describe("parseScan", () => {
  it("يوجّه رقم الفاتورة المشوّه بالتخطيط العربي كفاتورة لا كباركود منتج", () => {
    expect(parseScan("÷آ{-1-20260806-00068")).toEqual({
      type: "invoice",
      number: "INV-1-20260806-00068",
    });
  });

  it("يوجّه باركود الإرسالية الكامل إلى سجل الإرسالية بلا تحويله إلى باركود منتج", () => {
    expect(parseScan("CN-1-20260917-00275")).toEqual({
      type: "consignment",
      number: "CN-1-20260917-00275",
    });
  });
});

describe("resolveShippingLabelQrTarget", () => {
  it("لا يصنع رابط تحقق وهمياً من رقم الطلب غير الموقّع", () => {
    expect(resolveShippingLabelQrTarget({ orderNumber: "CN-1-20260917-00275" })).toBeNull();
  });

  it("يستعمل رابط صفحة الطلب الحقيقي الذي أرسله الخادم", () => {
    expect(resolveShippingLabelQrTarget({
      orderNumber: "CN-1-20260917-00275",
      qrUrl: "https://erp.example/verify?payload=SIGNED",
    })).toBe("https://erp.example/verify?payload=SIGNED");
  });
});
