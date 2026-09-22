import { printDeliverySlip, printReadyOrderLabel, type LabelPrintableOrder } from "@/lib/printing/deliveryDocs";
import { preopenShippingLabelWindow } from "@/lib/printing/shippingLabel";
import type { DispatchedItemHistory } from "./RecentDispatchesList";

export function printDispatchedItem(item: DispatchedItemHistory, labelWin?: Window | null) {
  const win = labelWin ?? preopenShippingLabelWindow();
  const printableOrder: LabelPrintableOrder = {
    orderNumber: item.sourceNumber,
    title:
      item.sourceType === "ONLINE_ORDER"
        ? `طلب متجر #${item.sourceNumber}`
        : item.sourceType === "INVOICE"
        ? `فاتورة مبيعات #${item.sourceNumber}`
        : `أمر شغل #${item.sourceNumber}`,
    quantity: 1,
    salePrice: item.codAmount,
    deposit: "0",
    customerName: item.recipientName ?? null,
    customerPhone: item.recipientPhone ?? null,
    deliveryAddress: item.deliveryAddress ?? null,
    deliveryCost: item.deliveryFee,
    qrUrl: item.qrUrl ?? null,
  };

  try {
    printDeliverySlip(
      printableOrder,
      { name: item.partyName },
      {
        consignmentNumber: item.consignmentNumber,
        invoiceNumber: item.invoiceNumber ?? item.sourceNumber,
        codAmount: item.codAmount,
        deliveryFee: item.deliveryFee,
        externalTrackingRef: item.externalTrackingRef || undefined,
      },
    );
    void printReadyOrderLabel(printableOrder, {
      partyName: item.partyName,
      trackingNumber: item.consignmentNumber,
      cod: item.codAmount,
      externalTrackingRef: item.externalTrackingRef || undefined,
      into: win,
    });
  } catch {
    win?.close();
  }
}
