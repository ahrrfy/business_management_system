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
 * المتوارثة في الكتالوج. لا نحسم بين وحدتين متعارضتين؛ أولوية الأساسي داخل الوحدة نفسها فقط.
 */
export function resolveProductBarcodeMatch(
  units: readonly ScannableProductUnit[],
  raw: string,
): ProductBarcodeMatch | null {
  const scannedBarcode = canonicalizeBarcodeInput(raw);
  if (!scannedBarcode) return null;

  const matches = units.filter((unit) => unitMatchesBarcode(unit, scannedBarcode));
  if (matches.length !== 1) return null;
  const primary = matches.find((unit) => unit.barcode != null && barcodesEquivalent(unit.barcode, scannedBarcode));
  if (primary) {
    return {
      kind: "PRIMARY",
      scannedBarcode,
      primaryBarcode: primary.barcode,
      unitName: primary.unitName,
      factor: primary.factor,
    };
  }

  const alias = matches[0];
  if (!alias) return null;
  return {
    kind: "ALIAS",
    scannedBarcode,
    primaryBarcode: alias.barcode,
    unitName: alias.unitName,
    factor: alias.factor,
  };
}

function unitMatchesBarcode(unit: ScannableProductUnit, raw: string): boolean {
  return (unit.barcode != null && barcodesEquivalent(unit.barcode, raw))
    || unit.aliases.some((code) => barcodesEquivalent(code, raw));
}

/** لا تُفتح بطاقة أول صنف عند اشتراك صنفين أو وحدتين في هوية المسح. */
export function resolveProductBarcodeItem<T extends { units: readonly ScannableProductUnit[] }>(
  items: readonly T[],
  raw: string,
): { status: "FOUND"; item: T; match: ProductBarcodeMatch } | { status: "NOT_FOUND" | "AMBIGUOUS" } {
  const matches = items.filter((item) => item.units.some((unit) => unitMatchesBarcode(unit, raw)));
  if (!matches.length) return { status: "NOT_FOUND" };
  if (matches.length > 1) return { status: "AMBIGUOUS" };
  const match = resolveProductBarcodeMatch(matches[0].units, raw);
  return match ? { status: "FOUND", item: matches[0], match } : { status: "AMBIGUOUS" };
}
