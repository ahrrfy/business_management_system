import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";

// Fix rounding policy once, globally: HALF_UP at high precision; round at boundaries.
Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 40 });

export const MONEY_DP = 2;
export type Money = string;
export type DecimalInput = string | number | Decimal;

/** Parse any money/quantity input into a Decimal. Throws on NaN/Infinity. */
export function money(x: DecimalInput | null | undefined): Decimal {
  if (x === null || x === undefined || x === "") return new Decimal(0);
  let d: Decimal;
  try {
    d = new Decimal(x);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: `قيمة غير صالحة: ${String(x)}` });
  }
  if (!d.isFinite()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `قيمة مالية غير صالحة: ${String(x)}` });
  }
  return d;
}

export const round2 = (x: DecimalInput): Decimal => money(x).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);

/** Round to 2dp and serialize for a decimal(15,2) column, e.g. "100.00". */
export const toDbMoney = (x: DecimalInput): Money => round2(x).toFixed(MONEY_DP);

/** Serialize a quantity for a decimal(15,3) column. */
export const toDbQty = (x: DecimalInput): string =>
  money(x).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);

export const sumMoney = (vs: DecimalInput[]): Decimal =>
  vs.reduce<Decimal>((a, v) => a.plus(money(v)), new Decimal(0));

export const gte = (a: DecimalInput, b: DecimalInput): boolean => money(a).gte(money(b));

/** Clamp x to [0, max]. */
export function clampMoney(x: DecimalInput, max: DecimalInput): Decimal {
  const d = money(x);
  if (d.isNegative()) return new Decimal(0);
  const m = money(max);
  return d.gt(m) ? m : d;
}

/** فرق موجب بين قيمتين ماليتين، مقصّ عند الصفر. مفيد لحساب «المتبقّي» من total و paidAmount
 *  بدقّة Decimal، عوضاً عن `Math.max(0, total - paid)` على floats (§٥ violation). */
export function positiveDiff(a: DecimalInput, b: DecimalInput): Decimal {
  const d = money(a).sub(money(b));
  return d.isNegative() ? new Decimal(0) : d;
}

/** تقريب نقدي للدينار العراقي: يرفع/يخفض إلى أقرب مضاعف لـ`denom` (افتراضياً ٢٥٠ د.ع).
 *  المنطق: في العراق لا فئات أصغر من ٢٥٠/٥٠٠، فقبول مبلغ ٥٤٥ نقداً يخلق فكّةً وهمية.
 *  السياسة: HALF_UP — ٥٤٥ → ٥٠٠ (الأقرب)، ١٢٥ → صفر (الأقرب)، ١٢٦ → ٢٥٠.
 *  لا يتعامل مع السالب (يُعامل كصفر). للحالات غير النقدية لا تستعمله — احتفظ بدقّة 2dp. */
export function roundCashIQD(amount: DecimalInput, denom: number = 250): Decimal {
  if (!Number.isInteger(denom) || denom <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `وحدة تقريب غير صالحة: ${denom}` });
  }
  const a = money(amount);
  if (a.isNegative() || a.isZero()) return new Decimal(0);
  // round = floor((a + denom/2) / denom) × denom
  const halfDenom = new Decimal(denom).div(2);
  const quotient = a.plus(halfDenom).div(denom).floor();
  return quotient.times(denom);
}

/** Today's date as YYYY-MM-DD for a `date` column. */
export const toDateStr = (d: Date = new Date()): string => d.toISOString().slice(0, 10);
