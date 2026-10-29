import { D } from "@/lib/money";
import { docBarcode } from "@shared/documentNumber";
import type { ShippingLabelData } from "./shippingLabel";
import { invoicePrintAmounts } from "./receiptLayoutInvoiceAmounts";
import { invoiceDeliveryCollection } from "@shared/invoiceDeliveryCollection";

export interface InvoiceShippingLabelSource {
  invoiceNumber: string;
  invoiceDate: Date | string;
  total: string | number;
  paidAmount?: string | number | null;
  returnedTotal?: string | number | null;
  paymentMode?: string | null;
  status?: string | null;
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
  const facts = invoicePrintAmounts(invoice);
  const collection = invoiceDeliveryCollection({
    remainingAmount: facts.remainingAmount,
    paymentMode: invoice.paymentMode,
    status: invoice.status,
    fee: invoice.courierFee,
    feeCollection: invoice.courierFeeCollection,
  });
  const cod = D(collection.atDoorDue);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return {
    orderNumber: invoice.invoiceNumber,
    barcodeValue: docBarcode("INV", invoice.invoiceNumber),
    customerName: invoice.recipientName ?? invoice.customerName ?? null,
    customerPhone: invoice.recipientPhone ?? invoice.customerPhone ?? null,
    governorate: invoice.deliveryGovernorate ?? null,
    addressText: invoice.deliveryAddress ?? invoice.customerAddress ?? null,
    total: cod.toFixed(2),
    paymentState: facts.dead ? "CLOSED" : cod.gt(0) ? "COD" : D(collection.creditDue).gt(0) ? "CREDIT" : "PREPAID",
    ...(D(collection.creditDue).gt(0) ? { creditAmount: collection.creditDue } : {}),
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
