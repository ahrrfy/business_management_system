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

  // التفاصيل المالية: إجمالي الطلب، المدفوع مسبقاً، المتبقي
  const rawTotal = firstWo ? Number(firstWo.total ?? 0) : Number(firstRec?.total ?? 0);
  const rawDeposit = firstWo ? Number(firstWo.paidUpfront ?? 0) : 0;
  const rawBalance = firstWo ? Number(firstWo.balanceDue ?? rawTotal) : rawTotal;

  let subtotal: string | null = rawTotal > 0 ? String(rawTotal) : null;
  let paidAmount: string | null = rawDeposit > 0 ? String(rawDeposit) : null;
  let shippingFee: string | null = null;
  let t = String(rawBalance);

  if (deliveryDeparture) {
    orderNum = deliveryDeparture.consignmentNumber || orderNum;
    cName = deliveryDeparture.customerName || cName;
    cPhone = deliveryDeparture.customerPhone || cPhone;
    t = String(deliveryDeparture.codAmount);
    if (deliveryDeparture.deliveryFee && Number(deliveryDeparture.deliveryFee) > 0) {
      shippingFee = String(deliveryDeparture.deliveryFee);
    }
  }

  const items = firstWo
    ? [{ productName: firstWo.jobTitle || "", unitName: "", quantity: String(firstWo.quantity || "1") }]
    : (firstRec?.items || []).map((i: any) => ({
        productName: i.name,
        unitName: "",
        quantity: String(i.quantity),
      }));

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const qrUrl = orderNum && origin ? `${origin}/verify?ref=${encodeURIComponent(orderNum)}` : null;

  void printShippingLabel({
    orderNumber: orderNum,
    customerName: cName || null,
    customerPhone: cPhone || null,
    governorate: null,
    addressText: deliveryDeparture?.deliveryAddress ?? null,
    total: t,
    subtotal,
    shippingFee,
    paidAmount,
    qrUrl,
    items,
  });
}
