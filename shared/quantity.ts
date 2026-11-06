import Decimal from "decimal.js";

export type QuantityInput = Decimal.Value;
export const QUANTITY_SCALE = 4;
export const MAX_QUANTITY = "99999999999.9999";

/** Exact inventory precision; never round a physical quantity to fit storage. */
export function quantityDecimal(value: QuantityInput): Decimal {
  if (typeof value === "string" && !value.trim()) throw new Error("كمية المخزون فارغة");
  const result = new Decimal(value);
  if (!result.isFinite() || result.decimalPlaces() > QUANTITY_SCALE || result.abs().gt(MAX_QUANTITY)) {
    throw new Error("كمية المخزون يجب أن تكون منتهية وبأربع منازل عشرية ضمن الحد المسموح");
  }
  return result;
}

/** Preserve existing numeric APIs only when the exact decimal round-trips. */
export function quantityNumber(value: QuantityInput): number {
  const result = quantityDecimal(value);
  const numeric = result.toNumber();
  if (!new Decimal(numeric).eq(result)) throw new Error("كمية المخزون لا تقبل التحويل الآمن");
  return numeric;
}

export function toDbQuantity(value: QuantityInput): string {
  return quantityDecimal(value).toFixed(QUANTITY_SCALE);
}

export function isQuantity(value: unknown): value is number {
  if (typeof value !== "number") return false;
  try { quantityNumber(value); return true; } catch { return false; }
}

export function addQuantities(...values: QuantityInput[]): number {
  return quantityNumber(values.reduce<Decimal>((total, value) => total.plus(quantityDecimal(value)), new Decimal(0)));
}

export function subtractQuantities(left: QuantityInput, right: QuantityInput): number {
  return quantityNumber(quantityDecimal(left).minus(quantityDecimal(right)));
}

export function multiplyQuantities(left: QuantityInput, right: QuantityInput): number {
  return quantityNumber(quantityDecimal(left).times(quantityDecimal(right)));
}
