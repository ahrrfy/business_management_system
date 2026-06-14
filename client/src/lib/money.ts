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

/** تنسيق مبلغ **للعرض فقط**: فواصل آلاف + منزلتان ثابتتان (1,234,567.89) — طلب المالك ١١/٦
 *  لتجنّب سهو قراءة المبالغ الكبيرة. ⛔ ممنوع في حمولات الـAPI (zod moneyStr يرفض الفواصل) —
 *  للإرسال استعمل round2(D(v)).toFixed(2). */
export const fmt = (v: string | number | null | undefined) =>
  round2(D(v)).toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** فرق موجب بدقّة Decimal — مكافئ خادمي `positiveDiff` لحساب «المتبقّي» بلا انجراف float.
 *  Math.max(0, Number(total) - Number(paid)) → positiveDiff(total, paid).toFixed(2) */
export const positiveDiff = (a: string | number | null | undefined, b: string | number | null | undefined) => {
  const d = D(a).minus(D(b));
  return d.isNegative() ? new Decimal(0) : d;
};

/** تقريب نقدي للدينار العراقي على الواجهة (مكافئ خادمي `roundCashIQD`). يُستعمل في الكاشير قبل
 *  إرسال طلب البيع النقدي ⇒ يلغي الفكّة الوهمية (لا توجد فئات أصغر من ٢٥٠ د.ع).
 *  HALF_UP إلى أقرب مضاعف لـ`denom`. سالب/صفر ⇒ صفر. */
export const roundCashIQD = (amount: string | number | null | undefined, denom: number = 250) => {
  const a = D(amount);
  if (a.isNegative() || a.isZero()) return new Decimal(0);
  const halfDenom = D(denom).div(2);
  const q = a.plus(halfDenom).div(denom).floor();
  return q.times(denom);
};

/** Format integer money (IQD whole-number) with locale separators. Decimal-safe sum first if needed. */
export const fmtInt = (v: string | number | null | undefined) =>
  D(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber().toLocaleString("ar-IQ-u-nu-latn");

/** نسبة كسرية (0.05) ⇒ نصّ مئوي "5%" (منزلة واحدة، تُجرَّد ".0"). */
export const pct = (frac: string | number | null | undefined) =>
  `${Math.round((Number(frac ?? 0) * 100) * 10) / 10}`.replace(/\.0$/, "") + "%";
