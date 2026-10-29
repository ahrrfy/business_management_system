import { D, moneyInput, round2 } from "@/lib/money";
import { printShippingLabel, resolveShippingLabelPaymentState } from "@/lib/printing/shippingLabel";
import type { PrintWindowOptions } from "@/lib/printing/print";
import type { LastSaleSummary } from "./cartMath";
import type { DeliveryDepartureData } from "../delivery/DeliveryDepartureOverlay";

export function triggerReceptionShippingLabel(
  lastSale: LastSaleSummary,
  deliveryDeparture: DeliveryDepartureData | null,
  fallbackPhone: string | null,
  options?: PrintWindowOptions & { isReprint?: boolean },
) {
  const firstWo = lastSale.workOrders[0];
  const firstRec = lastSale.receipts[0];

  let orderNum = firstWo?.orderNumber ?? firstRec?.receiptNumber ?? "";
  let cName = firstWo?.customerName ?? firstRec?.customerName ?? "";
  let cPhone = firstWo?.customerPhone ?? fallbackPhone ?? "";

  // التفاصيل المالية: إجمالي الطلب، المدفوع مسبقاً، المتبقي (عبر decimal.js حصراً)
  const rawTotal = firstWo
    ? round2(moneyInput(firstWo.total))
    : round2(moneyInput(firstRec?.total));
  const rawDeposit = firstWo ? round2(moneyInput(firstWo.paidUpfront)) : D(0);
  const rawBalance = firstWo
    ? round2(moneyInput(firstWo.balanceDue ?? rawTotal.toFixed(2)))
    : rawTotal;

  const subtotal: string | null = rawTotal.gt(0) ? rawTotal.toFixed(2) : null;
  const paidAmount: string | null = rawDeposit.gt(0) ? rawDeposit.toFixed(2) : null;
  let shippingFee: string | null = null;
  let dueDec = rawBalance;

  if (deliveryDeparture) {
    orderNum = deliveryDeparture.consignmentNumber || orderNum;
    cName = deliveryDeparture.customerName || cName;
    cPhone = deliveryDeparture.customerPhone || cPhone;
    if (
      deliveryDeparture.codAmount != null &&
      String(deliveryDeparture.codAmount).trim() !== ""
    ) {
      dueDec = round2(moneyInput(deliveryDeparture.codAmount));
    }
    const feeD = round2(moneyInput(deliveryDeparture.deliveryFee));
    if (feeD.gt(0)) {
      shippingFee = feeD.toFixed(2);
      if (deliveryDeparture.feeCollection === "COURIER") {
        dueDec = round2(dueDec.plus(feeD));
      }
    }
  }

  const t = dueDec.toFixed(2);

  const items = firstWo
    ? [{ productName: firstWo.jobTitle || "", unitName: "", quantity: String(firstWo.quantity || "1") }]
    : (firstRec?.items || []).map((i: any) => ({
        productName: i.name,
        unitName: "",
        quantity: String(i.quantity),
      }));

  const validRef = orderNum.trim() && orderNum.trim() !== "—" ? orderNum.trim() : "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const qrUrl = validRef && origin ? `${origin}/verify?ref=${encodeURIComponent(validRef)}` : null;

  return printShippingLabel({
    orderNumber: validRef || "—",
    barcodeValue: validRef || null,
    customerName: cName || null,
    customerPhone: cPhone || null,
    governorate: null,
    addressText: deliveryDeparture?.deliveryAddress ?? null,
    total: t,
    subtotal,
    shippingFee,
    paidAmount,
    paymentState: resolveShippingLabelPaymentState(dueDec.toNumber()),
    isReprint: options?.isReprint,
    qrUrl,
    items,
  }, options && "into" in options ? { into: options.into } : undefined);
}
