import { printShippingLabel } from "@/lib/printing/shippingLabel";
import type { LastSaleSummary } from "./cartMath";
import type { DeliveryDepartureData } from "../delivery/DeliveryDepartureOverlay";

export function triggerReceptionShippingLabel(
  lastSale: LastSaleSummary,
  deliveryDeparture: DeliveryDepartureData | null,
  fallbackPhone: string | null
) {
  const firstWo = lastSale.workOrders[0];
  const firstRec = lastSale.receipts[0];

  let orderNum = firstWo?.orderNumber ?? firstRec?.receiptNumber ?? "";
  let cName = firstWo?.customerName ?? firstRec?.customerName ?? "";
  let cPhone = firstWo?.customerPhone ?? fallbackPhone ?? "";
  let t = firstWo ? String(firstWo.balanceDue ?? 0) : String(firstRec?.total ?? 0);

  if (deliveryDeparture) {
    orderNum = deliveryDeparture.consignmentNumber || orderNum;
    cName = deliveryDeparture.customerName || cName;
    cPhone = deliveryDeparture.customerPhone || cPhone;
    t = String(deliveryDeparture.codAmount);
  }

  const items = firstWo
    ? [{ productName: firstWo.jobTitle || "", unitName: "", quantity: String(firstWo.quantity || "1") }]
    : (firstRec?.items || []).map((i: any) => ({
        productName: i.name,
        unitName: "",
        quantity: String(i.quantity),
      }));

  void printShippingLabel({
    orderNumber: orderNum,
    customerName: cName || null,
    customerPhone: cPhone || null,
    governorate: null,
    addressText: deliveryDeparture?.deliveryAddress ?? null,
    total: t,
    items,
  });
}
