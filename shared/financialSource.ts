import { paymentMethodTerm } from "./terms";

/** مكان المال أو مصدر التمويل؛ مستقل عن طريقة الدفع (shared/terms). */
export const FINANCIAL_SOURCE_LABEL = {
  DRAWER: "درج كاشير",
  TREASURY: "خزينة إدارية",
  BANK: "حساب بنكي",
  STOCK: "مخزون",
  OTHER: "مصدر آخر",
} as const;

/** يقبل رموزاً تاريخية غير معروفة ويحافظ على نصها الأصلي. */
export function financialSourceLabel(code: string, original = code): string {
  return (
    (Object.hasOwn(FINANCIAL_SOURCE_LABEL, code)
      ? FINANCIAL_SOURCE_LABEL[code as keyof typeof FINANCIAL_SOURCE_LABEL]
      : null) ??
    paymentMethodTerm(code)?.compact ??
    original
  );
}
