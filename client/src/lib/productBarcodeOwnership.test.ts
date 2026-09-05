import { describe, expect, it } from "vitest";
import {
  findForeignBarcodeUsages,
  findTakenEditableBarcodeCodes,
  type EditableBarcodeField,
  type StoredBarcodeUsage,
} from "./productBarcodeOwnership";

const selfField: EditableBarcodeField = {
  fieldKey: "variant-41:unit-1",
  code: "036000291452",
};
const originalCodes = new Map([[selfField.fieldKey, "0036000291452"]]);

const selfStoredAsEan: StoredBarcodeUsage = {
  code: "0036000291452",
  takenBy: "منتج الاختبار (SKU-1)",
};

describe("product barcode edit ownership", () => {
  it("keeps an equivalent UPC/EAN representation owned by the same original unit", () => {
    expect(findForeignBarcodeUsages([selfStoredAsEan], [selfField], originalCodes)).toEqual([]);
    expect(findTakenEditableBarcodeCodes([selfStoredAsEan], [selfField], originalCodes)).toEqual(new Set());
  });

  it("does not hide an equivalent identity owned by another unit", () => {
    const otherUnit = {
      code: "036000291452",
      takenBy: "منتج آخر (SKU-2)",
    };

    expect(findForeignBarcodeUsages([selfStoredAsEan, otherUnit], [selfField], originalCodes)).toEqual([otherUnit]);
    expect(findTakenEditableBarcodeCodes([selfStoredAsEan, otherUnit], [selfField], originalCodes)).toEqual(
      new Set(["036000291452"]),
    );
  });

  it("does not hide an alias because it was not the field's original stored code", () => {
    const sameUnitAlias = { code: "036000291452", takenBy: "منتج الاختبار (SKU-1) — بديل" };

    expect(findForeignBarcodeUsages([sameUnitAlias], [selfField], originalCodes)).toEqual([sameUnitAlias]);
  });

  it("does not mistake a newly entered exact foreign barcode for an owned code", () => {
    const foreign = {
      ...selfStoredAsEan,
      code: "6001000000031",
    };
    const changedField = { ...selfField, code: "6001000000031" };

    expect(findForeignBarcodeUsages([foreign], [changedField], originalCodes)).toEqual([foreign]);
    expect(findTakenEditableBarcodeCodes([foreign], [changedField], originalCodes)).toEqual(
      new Set(["6001000000031"]),
    );
  });

  it("does not let one self-owned field hide the same identity from a new field", () => {
    const newField = { fieldKey: "variant-41:unit-2", code: "036000291452" };

    expect(findForeignBarcodeUsages([selfStoredAsEan], [selfField, newField], originalCodes)).toEqual([selfStoredAsEan]);
    expect(findTakenEditableBarcodeCodes([selfStoredAsEan], [selfField, newField], originalCodes)).toEqual(
      new Set(["036000291452"]),
    );
  });
});
