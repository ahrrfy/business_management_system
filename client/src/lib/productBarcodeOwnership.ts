import { barcodesEquivalent } from "@shared/barcodeNormalize";

export type StoredBarcodeUsage = {
  code: string;
  takenBy: string;
};

export type EditableBarcodeField = {
  fieldKey: string;
  code: string;
};

/**
 * يطابق الردّ بهوية الباركود، لكن يستثني الملكية الذاتية بالنص المخزّن الأصلي للحقل نفسه فقط.
 * الخادم يعيد النص المخزّن، لذلك يبقى UPC مكافئ مخزّن في حقل آخر تعارضاً ولا يختفي مع EAN الأصلي.
 */
export function findForeignBarcodeUsages(
  usages: StoredBarcodeUsage[],
  fields: EditableBarcodeField[],
  originalCodes: ReadonlyMap<string, string | null>,
): StoredBarcodeUsage[] {
  return usages.filter((usage) => {
    const matchingFields = fields.filter((field) => barcodesEquivalent(field.code, usage.code));
    return matchingFields.some((field) => originalCodes.get(field.fieldKey) !== usage.code);
  });
}

export function findTakenEditableBarcodeCodes(
  usages: StoredBarcodeUsage[],
  fields: EditableBarcodeField[],
  originalCodes: ReadonlyMap<string, string | null>,
): Set<string> {
  const foreign = findForeignBarcodeUsages(usages, fields, originalCodes);
  return new Set(
    fields
      .filter((field) => foreign.some((usage) => barcodesEquivalent(field.code, usage.code)))
      .map((field) => field.code),
  );
}
