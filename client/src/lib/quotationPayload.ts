import type { InvoiceLine } from "@/components/invoice";
import { D } from "@/lib/money";

type QuotationPayloadLine = Pick<
  InvoiceLine,
  | "variantId"
  | "productUnitId"
  | "qty"
  | "price"
  | "referencePrice"
  | "discount"
  | "discountType"
>;

/**
 * يبني سطر عرض السعر مع إبقاء `unitPriceOverride` دلالةً لتدخل المستخدم فقط.
 * السطر القديم بلا مرجع يفشل بأمان: نحفظ سعره الظاهر كتجاوز ولا نعيد تسعيره صامتاً.
 */
export function buildQuotationLinePayload(line: QuotationPayloadLine) {
  const hasExplicitOverride =
    line.referencePrice == null || !D(line.price).eq(D(line.referencePrice));
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
