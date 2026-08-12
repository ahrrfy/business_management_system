import { describe, expect, it } from "vitest";
import { normalizeBarcodeScannerInput, normalizeKnownSystemBarcode } from "./barcodeScannerInput";
import { parseScan } from "./scanRouter";

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
  });
});

describe("parseScan", () => {
  it("يوجّه رقم الفاتورة المشوّه بالتخطيط العربي كفاتورة لا كباركود منتج", () => {
    expect(parseScan("÷آ{-1-20260806-00068")).toEqual({
      type: "invoice",
      number: "INV-1-20260806-00068",
    });
  });
});
