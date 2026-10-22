/**
 * شعارا فيزا وماستركارد (Visa & Mastercard) لقوالب الطباعة والفواتير والإيصالات.
 * يُستخدم في الفواتير المطبوعة (A4 والحرارية) عندما تكون طريقة الدفع بالبطاقة.
 */

export const CARD_BRAND_LOGO_URL = "/visa-mastercard.png";

/** يتحقّق ممّا إذا كانت قيمة طريقة الدفع ترمز للدفع بالبطاقة (CARD أو نص يحوي «بطاقة»). */
export function isCardPaymentMethod(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (trimmed.includes("بطاقة هدية") || trimmed.includes("بطاقات رقمية")) return false;
  const upper = trimmed.toUpperCase();
  return (
    upper === "CARD" ||
    /\bCARD\b/.test(upper) ||
    upper.includes("VISA") ||
    upper.includes("MASTERCARD") ||
    trimmed.includes("بطاقة")
  );
}

/** يرجع وسم صورة الشعارين (Visa + Mastercard) مضمّناً للطباعة داخل HTML. */
export function cardBrandLogosHtml(opts?: { heightPx?: number }): string {
  const h = opts?.heightPx ?? 16;
  const w = Math.round(h * 3);
  return `<img src="${CARD_BRAND_LOGO_URL}" alt="Visa &amp; Mastercard" width="${w}" height="${h}" style="display:inline-block;vertical-align:middle;height:${h}px;width:auto;object-fit:contain;margin-inline-start:4px;" />`;
}

/**
 * يُنسّق قيمة حقل «طريقة الدفع» في قوالب الطباعة بحيث يعرض الشعارين (Visa + Mastercard)
 * بجانب النصّ متى كانت الطريقة بطاقة.
 */
export function formatPaymentMethodPrintHtml(
  value: string,
  escFn: (s: unknown) => string,
  opts?: { heightPx?: number },
): string {
  const trimmed = String(value ?? "").trim();
  const displayValue = trimmed.toUpperCase() === "CARD" ? "بطاقة" : trimmed;
  const escaped = escFn(displayValue);
  if (!isCardPaymentMethod(trimmed)) return escaped;
  return `<span style="display:inline-flex;align-items:center;gap:5px;vertical-align:middle;"><span>${escaped}</span>${cardBrandLogosHtml(opts)}</span>`;
}
