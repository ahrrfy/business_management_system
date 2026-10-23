import type { InvoiceLine } from "@/components/invoice";
import { moneyInput, round2 } from "@/lib/money";

type QuotationPayloadLine = Pick<
  InvoiceLine,
  | "variantId"
  | "productUnitId"
  | "qty"
  | "price"
  | "referencePrice"
  | "priceSource"
  | "discount"
  | "discountType"
>;

/**
 * يتحقّق أن النصّ الماليّ مكتمل وصالح للإرسال (وليس فارغاً أو فاصلة عشرية معلّقة مثل "." أو "-").
 * - عند `allowEmpty: false` (مثل سعر الوحدة `l.price`): يرفض `""` حتى لا يتحوّل مسح السعر أو
 *   فقد التركيز بعد كتابة `"."` (`stripTrailingZeros(".") === ""`) إلى `0.00` صامتة.
 * - عند `allowEmpty: true` (مثل الخصم/الضريبة الاختياريين): يقبل `""` كصفر، ويرفض `"."` و`"-"` والسالب.
 */
export function isCompleteNonNegativeMoneyInput(
  raw: string | number | null | undefined,
  opts?: { allowEmpty?: boolean },
): boolean {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0;
  }
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return opts?.allowEmpty === true;
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    return false;
  }
  return !moneyInput(trimmed).lt(0);
}

/**
 * يبني سطر عرض السعر مع إبقاء `unitPriceOverride` دلالةً لتدخل المستخدم فقط.
 * السطر القديم بلا مرجع يفشل بأمان: نحفظ سعره الظاهر كتجاوز ولا نعيد تسعيره صامتاً.
 */
export function buildQuotationLinePayload(line: QuotationPayloadLine) {
  if (!isCompleteNonNegativeMoneyInput(line.price, { allowEmpty: false })) {
    throw new Error("INVALID_QUOTATION_LINE_PRICE");
  }
  const hasExplicitOverride = shouldSendUnitPriceOverride(line);
  return {
    variantId: line.variantId,
    productUnitId: line.productUnitId,
    quantity: moneyInput(line.qty).toString(),
    ...(hasExplicitOverride
      ? { unitPriceOverride: round2(moneyInput(line.price)).toFixed(2) }
      : {}),
    discountPercent:
      line.discountType === "percent"
        ? round2(moneyInput(line.discount || "0")).toFixed(2)
        : undefined,
    discountAmount:
      line.discountType === "amount"
        ? round2(moneyInput(line.discount || "0")).toFixed(2)
        : undefined,
  };
}

/**
 * لا نرسل السعر الآلي كتجاوز. MANUAL يبقى صريحاً حتى لو ساوى المرجع رقمياً، وأي سطر
 * legacy بلا وسم/مرجع يحافظ على سعره الظاهر بدلاً من إعادة تسعيره صامتاً.
 */
export function shouldSendUnitPriceOverride(
  line: Pick<InvoiceLine, "price" | "referencePrice" | "priceSource">,
): boolean {
  return (
    line.priceSource == null ||
    line.referencePrice == null ||
    line.priceSource === "MANUAL" ||
    !moneyInput(line.price).eq(moneyInput(line.referencePrice))
  );
}
