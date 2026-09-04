import { barcodesEquivalent, canonicalizeBarcodeInput } from "./barcodeNormalize";

/**
 * هوية مسح المنتج الدنيا المشتركة بين مسارات الجرد والتسوية.
 *
 * لا تحمل سعراً أو تكلفةً أو رصيداً: هي تشرح فقط أيّ وحدة طابقها الكود، وهل كان
 * الباركود أساسياً أم بديلاً. بذلك تبقى صالحةً لواجهة العامل والجرد الأعمى بلا تسريب.
 */
export type ProductBarcodeMatchKind = "PRIMARY" | "ALIAS";

export type ScannableProductUnit = {
  unitName: string;
  /** عدد وحدات الأساس في الوحدة الممسوحة. */
  factor: number;
  /** الباركود الأساسي للوحدة، إن وُجد. */
  barcode: string | null;
  /** الباركودات البديلة التي تعود إلى الوحدة نفسها. */
  aliases: readonly string[];
};

export type ProductBarcodeMatch = {
  kind: ProductBarcodeMatchKind;
  scannedBarcode: string;
  primaryBarcode: string | null;
  unitName: string;
  factor: number;
};

/**
 * نفس عقد الحلّ الخادمي: تطبيع مدخل الماسح + تكافؤ UPC-A/EAN-13 + عدم حساسية الحالة
 * المتوارثة في الكتالوج. الأساسي له الأولوية الدفاعية، ثم البديل.
 */
export function resolveProductBarcodeMatch(
  units: readonly ScannableProductUnit[],
  raw: string,
): ProductBarcodeMatch | null {
  const scannedBarcode = canonicalizeBarcodeInput(raw);
  if (!scannedBarcode) return null;

  const primary = units.find((unit) => unit.barcode != null && barcodesEquivalent(unit.barcode, scannedBarcode));
  if (primary) {
    return {
      kind: "PRIMARY",
      scannedBarcode,
      primaryBarcode: primary.barcode,
      unitName: primary.unitName,
      factor: primary.factor,
    };
  }

  const alias = units.find((unit) => unit.aliases.some((code) => barcodesEquivalent(code, scannedBarcode)));
  if (!alias) return null;
  return {
    kind: "ALIAS",
    scannedBarcode,
    primaryBarcode: alias.barcode,
    unitName: alias.unitName,
    factor: alias.factor,
  };
}
