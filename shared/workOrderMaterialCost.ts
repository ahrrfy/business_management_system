import Decimal from "decimal.js";
import { quantityDecimal, type QuantityInput } from "./quantity";

export interface WorkOrderMaterialCostSnapshot {
  baseQuantity: QuantityInput;
  unitCost?: Decimal.Value | null;
  lineCost?: Decimal.Value | null;
}

/** Nonnull issued value, including zero, is authoritative after any partial return. */
export function workOrderMaterialValue(snapshot: WorkOrderMaterialCostSnapshot): Decimal {
  const quantity = quantityDecimal(snapshot.baseQuantity);
  if (quantity.lte(0)) throw new Error("كمية دفعة الخامة غير موجبة");
  let value: Decimal;
  if (snapshot.lineCost == null) {
    if (!quantity.isInteger() || snapshot.unitCost == null) {
      throw new Error("دفعة خامة كسرية بلا لقطة قيمة صرف موثوقة");
    }
    value = new Decimal(snapshot.unitCost).times(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    value = new Decimal(snapshot.lineCost);
  }
  if (!value.isFinite() || value.isNegative() || value.decimalPlaces() > 2 || value.gt("9999999999999.99")) {
    throw new Error("قيمة لقطة دفعة الخامة غير صالحة");
  }
  return value;
}

/** Last return absorbs the remaining penny; never reconstruct from rounded unit cost. */
export function splitWorkOrderMaterialValue(
  snapshot: WorkOrderMaterialCostSnapshot,
  returnedBase: QuantityInput,
): { returnedValue: Decimal; remainingValue: Decimal } {
  const quantity = quantityDecimal(snapshot.baseQuantity);
  const returned = quantityDecimal(returnedBase);
  if (returned.lt(0) || returned.gt(quantity)) throw new Error("كمية الرجوع تتجاوز دفعة الخامة");
  const value = workOrderMaterialValue(snapshot);
  const returnedValue = returned.eq(quantity)
    ? value
    : value.times(returned).div(quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { returnedValue, remainingValue: value.minus(returnedValue) };
}
