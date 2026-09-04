import { describe, expect, it } from "vitest";
import { resolveProductBarcodeItem, resolveProductBarcodeMatch } from "./productScan";

const units = [
  { unitName: "قطعة", factor: 1, barcode: "BC-ONE", aliases: ["ALT-ONE"] },
  { unitName: "كرتون", factor: 12, barcode: "BC-BOX", aliases: ["ALT-BOX"] },
] as const;

describe("resolveProductBarcodeMatch", () => {
  it("يحفظ رمز الملصق الفعلي بمسافتين ويرفض الحسم بين صنفين", () => {
    const first = { id: 1, units: [{ unitName: "قطعة", factor: 1, barcode: "1  0095", aliases: [] }] };
    expect(resolveProductBarcodeItem([first], "1  0095")).toMatchObject({ status: "FOUND", item: { id: 1 } });
    expect(resolveProductBarcodeItem([first], "10095")).toEqual({ status: "NOT_FOUND" });
    expect(resolveProductBarcodeItem([first, { ...first, id: 2 }], "1  0095")).toEqual({ status: "AMBIGUOUS" });
  });
  it("يرفض التباس الأساسي والبديل بين وحدتين حتى لو كانت إحداهما مطابقة حرفياً", () => {
    expect(resolveProductBarcodeMatch([
      { unitName: "قطعة", factor: 1, barcode: "10095", aliases: [] },
      { unitName: "كرتون", factor: 12, barcode: "BOX", aliases: [" ١٠٠٩٥ "] },
    ], "10095")).toBeNull();
  });

  it("يميّز الباركود الأساسي ويعيد الوحدة ومعاملها", () => {
    expect(resolveProductBarcodeMatch(units, " BC-BOX ")).toEqual({
      kind: "PRIMARY",
      scannedBarcode: "BC-BOX",
      primaryBarcode: "BC-BOX",
      unitName: "كرتون",
      factor: 12,
    });
  });

  it("يميّز البديل ويعيد الأساسي لنفس الوحدة", () => {
    expect(resolveProductBarcodeMatch(units, "ALT-BOX")).toEqual({
      kind: "ALIAS",
      scannedBarcode: "ALT-BOX",
      primaryBarcode: "BC-BOX",
      unitName: "كرتون",
      factor: 12,
    });
  });

  it("لا يعامل SKU أو التطابق الجزئي كمسح باركود", () => {
    expect(resolveProductBarcodeMatch(units, "BC")).toBeNull();
    expect(resolveProductBarcodeMatch(units, "SKU-1")).toBeNull();
    expect(resolveProductBarcodeMatch(units, "   ")).toBeNull();
  });

  it("يطابق بنفس عقد الخادم: الأرقام العربية والحالة وUPC-A/EAN-13", () => {
    const normalizedUnits = [
      { unitName: "قطعة", factor: 1, barcode: "ALR000123", aliases: ["0036000291452"] },
    ] as const;
    expect(resolveProductBarcodeMatch(normalizedUnits, "alr٠٠٠١٢٣")).toMatchObject({
      kind: "PRIMARY",
      primaryBarcode: "ALR000123",
    });
    expect(resolveProductBarcodeMatch(normalizedUnits, "036000291452")).toMatchObject({
      kind: "ALIAS",
      primaryBarcode: "ALR000123",
    });
  });
});
