import { addQuantities, quantityNumber } from "@shared/quantity";

/** Quantity-only persisted projection. Existing integer projections remain valid. */
export const INVENTORY_PROJECTION_VERSION = 1;
export type TransitProjection = Record<string, string>;
export function baseInteger(value: unknown, label = "quantity"): number {
  if (typeof value !== "number" || value < 0)
    throw new Error(`Invalid projection ${label}`);
  return quantityNumber(value);
}
export function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid projection id");
  return value;
}
export function parseTransitProjection(value: unknown): TransitProjection {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Inventory projection uninitialized or malformed");
  const result: TransitProjection = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      !/^[1-9]\d*$/.test(key) ||
      positiveId(Number(key)).toString() !== key ||
      typeof raw !== "string" ||
      !/^(0|[1-9]\d*)(?:\.\d{1,4})?$/.test(raw)
    )
      throw new Error("Invalid inventory projection branch/quantity");
    const quantity = baseInteger(Number(raw));
    if (String(quantity) !== raw) throw new Error("Noncanonical inventory projection quantity");
    if (quantity) result[key] = String(quantity);
  }
  return result;
}
export function changeTransitProjection(
  value: unknown,
  sourceBranchId: number,
  delta: number,
): TransitProjection {
  const result = parseTransitProjection(value);
  const key = String(positiveId(sourceBranchId));
  const next = baseInteger(addQuantities(result[key] ?? "0", quantityNumber(delta)));
  if (next) result[key] = String(next);
  else delete result[key];
  return result;
}
export function addBaseQuantityChecked(
  target: Map<number, number>,
  variantId: number,
  quantity: number,
): void {
  const id = positiveId(variantId);
  target.set(id, baseInteger(addQuantities(target.get(id) ?? 0, baseInteger(quantity))));
}
