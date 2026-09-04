import { describe, expect, it } from "vitest";
import { resolveProductBarcodeMatch } from "./productScan";

const units = [
  { unitName: "قطعة", factor: 1, barcode: "BC-ONE", aliases: ["ALT-ONE"] },
  { unitName: "كرتون", factor: 12, barcode: "BC-BOX", aliases: ["ALT-BOX"] },
] as const;

describe("resolveProductBarcodeMatch", () => {
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
