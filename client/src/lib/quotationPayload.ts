import type { InvoiceLine } from "@/components/invoice";
import { D } from "@/lib/money";

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
 * يبني سطر عرض السعر مع إبقاء `unitPriceOverride` دلالةً لتدخل المستخدم فقط.
 * السطر القديم بلا مرجع يفشل بأمان: نحفظ سعره الظاهر كتجاوز ولا نعيد تسعيره صامتاً.
 */
export function buildQuotationLinePayload(line: QuotationPayloadLine) {
  const hasExplicitOverride = shouldSendUnitPriceOverride(line);
  return {
    variantId: line.variantId,
    productUnitId: line.productUnitId,
    quantity: D(line.qty).toString(),
    ...(hasExplicitOverride
      ? { unitPriceOverride: D(line.price).toFixed(2) }
      : {}),
    discountPercent:
      line.discountType === "percent"
        ? D(line.discount || "0").toFixed(2)
        : undefined,
    discountAmount:
      line.discountType === "amount"
        ? D(line.discount || "0").toFixed(2)
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
  return line.priceSource == null ||
    line.referencePrice == null ||
    line.priceSource === "MANUAL" ||
    !D(line.price).eq(D(line.referencePrice));
}
