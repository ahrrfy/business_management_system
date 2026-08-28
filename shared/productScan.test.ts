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
});
