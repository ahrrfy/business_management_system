import { D, round2 } from "@/lib/money";
import { docBarcode } from "@shared/documentNumber";
import type { ShippingLabelData } from "./shippingLabel";

export interface InvoiceShippingLabelSource {
  invoiceNumber: string;
  invoiceDate: Date | string;
  total: string | number;
  paidAmount?: string | number | null;
  returnedTotal?: string | number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  deliveryGovernorate?: string | null;
  courierName?: string | null;
  courierFee?: string | number | null;
  courierFeeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  externalTrackingRef?: string | null;
  qrPayload?: string | null;
  items: Array<{
    productName?: string | null;
    variantName?: string | null;
    unitName?: string | null;
    quantity: string | number;
  }>;
}

/** يحوّل حقيقة الفاتورة البديلة إلى ليبل شحن؛ COD هو المتبقي الفعلي لا إجمالي البيع. */
export function invoiceToShippingLabel(invoice: InvoiceShippingLabelSource): ShippingLabelData {
  const remainingRaw = D(invoice.total).minus(D(invoice.returnedTotal ?? 0)).minus(D(invoice.paidAmount ?? 0));
  const remaining = round2(remainingRaw.isNegative() ? D(0) : remainingRaw);
  const courierCollectsFee = invoice.courierFeeCollection === "COURIER";
  const cod = round2(remaining.plus(courierCollectsFee ? D(invoice.courierFee ?? 0) : D(0)));
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return {
    orderNumber: invoice.invoiceNumber,
    barcodeValue: docBarcode("INV", invoice.invoiceNumber),
    customerName: invoice.recipientName ?? invoice.customerName ?? null,
    customerPhone: invoice.recipientPhone ?? invoice.customerPhone ?? null,
    governorate: invoice.deliveryGovernorate ?? null,
    addressText: invoice.deliveryAddress ?? invoice.customerAddress ?? null,
    total: cod.toFixed(2),
    paymentState: cod.isZero() ? "PREPAID" : "COD",
    deliveryPartyName: invoice.courierName ?? null,
    externalTrackingRef: invoice.externalTrackingRef ?? null,
    qrUrl: invoice.qrPayload
      ? (origin ? `${origin}/verify?payload=${encodeURIComponent(invoice.qrPayload)}` : invoice.qrPayload)
      : null,
    createdAt: invoice.invoiceDate,
    items: invoice.items.map((item) => ({
      productName: [item.productName ?? "صنف", item.variantName].filter(Boolean).join(" — "),
      unitName: item.unitName ?? "وحدة",
      quantity: String(item.quantity),
    })),
  };
}
