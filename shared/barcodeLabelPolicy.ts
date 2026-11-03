/** Small roll labels reserve the entire printable area for barcode bars only. */
export const BARCODE_ONLY_HEIGHT_THRESHOLD_MM = 15;
export const BARCODE_ONLY_PAD_Y_MM = 0.5;

export function isBarcodeOnlyLabel(heightMm: number): boolean {
  return heightMm < BARCODE_ONLY_HEIGHT_THRESHOLD_MM;
}

/** Encoders already include their quiet zones; retain a small outer paper margin. */
export function labelHorizontalPaddingMm(heightMm: number): number {
  return isBarcodeOnlyLabel(heightMm) ? 0.5 : 1.5;
}

/** Whole 203dpi dots preserve narrow/wide bar ratios without fractional resampling. */
export function snappedBarcodeWidthMm(
  unitCount: number,
  labelWidthMm: number,
  heightMm = Infinity,
): number {
  const usableMm = labelWidthMm - 2 * labelHorizontalPaddingMm(heightMm);
  const dotsPerModule = Math.floor((usableMm * 8) / unitCount);
  return dotsPerModule >= 1 ? (unitCount * dotsPerModule) / 8 : 0;
}
