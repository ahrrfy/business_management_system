import Decimal from "decimal.js";

/** Client-side money helpers for display/preview only. The server recomputes authoritatively
 *  (server/services/money.ts). We still use decimal.js here to avoid float drift in previews
 *  and to mirror the server's HALF_UP rounding. Never use parseFloat/Number for money. */
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export const D = (v: string | number | null | undefined) => new Decimal(v == null || v === "" ? 0 : v);

/** Round to 2 dp, HALF_UP. */
export const round2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** unitPrice × quantity → 2dp string. */
export const lineTotal = (unitPrice: string | number, quantity: string | number) =>
  round2(D(unitPrice).times(D(quantity))).toFixed(2);

/** Sum a list of 2dp money strings → 2dp string. */
export const sum = (values: Array<string | number>) =>
  round2(values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0))).toFixed(2);

/** base = quantity × conversionFactor (must be an integer for the purchase to be valid). */
export const toBase = (quantity: string | number, conversionFactor: string | number) =>
  D(quantity).times(D(conversionFactor));

/** Format a money value for display (2 dp). */
export const fmt = (v: string | number | null | undefined) => round2(D(v)).toFixed(2);
