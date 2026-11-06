import { digitsArabicToLatin } from "@shared/numberNormalize";
import { addQuantities, multiplyQuantities, quantityNumber } from "@shared/quantity";

export function normalizeCountDraft(raw: string): string {
  return digitsArabicToLatin(raw).replace(/٫/g, ".");
}
export function calculateCountDraft(
  units: ReadonlyArray<{ unitName: string; factor: number }>,
  values: Readonly<Record<string, string>>,
) {
  const entries: Record<string, number> = {};
  let total = 0;
  try {
    for (const unit of units) {
      const raw = values[unit.unitName];
      if (raw === undefined || raw === "") continue;
      if (!/^(?:\d+(?:\.\d{0,4})?|\.\d{1,4})$/.test(raw))
        return { entries, total, valid: false };
      entries[unit.unitName] = quantityNumber(raw);
      total = addQuantities(total, multiplyQuantities(entries[unit.unitName], unit.factor));
    }
  } catch {
    return { entries, total, valid: false };
  }
  return { entries, total, valid: Object.keys(entries).length > 0 && total >= 0 && total <= 99_999_999 };
}
