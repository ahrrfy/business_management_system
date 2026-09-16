import type { OfflineCatalogRow } from "@shared/offlineCatalog";
import { resolveProductBarcodeItem } from "@shared/productScan";

type OfflineBarcodeCandidate = {
  row: OfflineCatalogRow;
  units: Array<{
    unitName: string;
    factor: number;
    barcode: string | null;
    aliases: string[];
  }>;
};

export type OfflineBarcodeResolution =
  | { status: "FOUND"; row: OfflineCatalogRow }
  | { status: "NOT_FOUND" | "AMBIGUOUS" };

/**
 * يحسم صفوف فهرس Dexie بالعقد نفسه الذي يحكم الجرد والخادم.
 * لا تستعمل `.first()` هنا: لقطة إرثية قد تحمل مالكَين لرمز واحد بعد التطبيع أو تكافؤ UPC/EAN.
 */
export function resolveOfflineBarcodeRows(
  rows: readonly OfflineCatalogRow[],
  raw: string,
): OfflineBarcodeResolution {
  const candidates: OfflineBarcodeCandidate[] = rows.map((row) => ({
    row,
    units: [{
      unitName: row.unitName,
      factor: Number(row.conversionFactor),
      barcode: row.barcode,
      aliases: row.allBarcodes.filter((code) => code !== row.barcode),
    }],
  }));
  const resolution = resolveProductBarcodeItem(candidates, raw);
  return resolution.status === "FOUND"
    ? { status: "FOUND", row: resolution.item.row }
    : { status: resolution.status };
}
