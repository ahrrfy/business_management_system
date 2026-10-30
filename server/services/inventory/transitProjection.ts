/** Quantity-only persisted projection. Source documents remain authoritative. */
export const INVENTORY_PROJECTION_VERSION = 1;
export type TransitProjection = Record<string, string>;
export function baseInteger(value: unknown, label = "quantity"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid projection ${label}`);
  return value;
}
export function positiveId(value: unknown): number {
  const id = baseInteger(value, "id");
  if (!id) throw new Error("Invalid projection id");
  return id;
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
      !/^(0|[1-9]\d*)$/.test(raw)
    )
      throw new Error("Invalid inventory projection branch/quantity");
    const quantity = baseInteger(Number(raw));
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
  if (!Number.isSafeInteger(delta)) throw new Error("Invalid projection delta");
  const next = baseInteger(Number(result[key] ?? "0") + delta);
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
  target.set(id, baseInteger((target.get(id) ?? 0) + baseInteger(quantity)));
}
