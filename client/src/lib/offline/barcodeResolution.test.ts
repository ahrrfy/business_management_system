import { describe, expect, it } from "vitest";
import type { OfflineCatalogRow } from "@shared/offlineCatalog";
import { resolveOfflineBarcodeRows } from "./barcodeResolution";

function row(overrides: Partial<OfflineCatalogRow>): OfflineCatalogRow {
  return {
    productUnitId: 1,
    productId: 1,
    productName: "مادة",
    variantId: 1,
    variantName: null,
    color: null,
    colorHex: null,
    size: null,
    sku: "SKU-1",
    unitName: "قطعة",
    conversionFactor: "1",
    barcode: "1  0095",
    allBarcodes: ["1  0095"],
    isBaseUnit: true,
    isService: false,
    allowBackorder: false,
    isBundle: false,
    isCustomizable: false,
    isPrintService: false,
    priceRetail: "1000",
    priceWholesale: null,
    priceGovernment: null,
    searchText: "ماده sku-1 1 0095",
    ...overrides,
  };
}

describe("resolveOfflineBarcodeRows", () => {
  it("يحافظ على مسافتي Code39 الداخليتين ويحل alias إلى صفه", () => {
    const candidate = row({ barcode: null, allBarcodes: ["1  0095"] });
    expect(resolveOfflineBarcodeRows([candidate], "\t1  0095\r")).toEqual({
      status: "FOUND",
      row: candidate,
    });
  });

  it("يفشل مغلقاً إذا طابق الرمز صفين ولا يأخذ أول صف من Dexie", () => {
    const first = row({ productUnitId: 1, variantId: 1 });
    const second = row({ productUnitId: 2, variantId: 2, productId: 2 });
    expect(resolveOfflineBarcodeRows([first, second], "1  0095")).toEqual({ status: "AMBIGUOUS" });
  });

  it("يوحّد UPC-A مع EAN-13 ذي الصفر البادئ", () => {
    const candidate = row({ barcode: "0036000291452", allBarcodes: ["0036000291452"] });
    expect(resolveOfflineBarcodeRows([candidate], "036000291452").status).toBe("FOUND");
  });
});
