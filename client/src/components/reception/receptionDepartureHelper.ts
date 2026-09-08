import type { DeliveryDepartureData } from "@/components/delivery/DeliveryDepartureOverlay";
import type { CartLine } from "@/components/reception/cartMath";

export interface BuildDepartureInput {
  dispatched: { consignmentNumber: string; codAmount: string };
  result: {
    workOrders: Array<{ orderNumber: string }>;
    regularSale?: { invoiceNumber: string } | null;
  };
  cart: CartLine[];
  customerName: string | null;
  receiptPhone: string;
  orderDelivery: {
    address?: string | null;
    partyName: string;
    fee?: string | number | null;
    feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  };
  courierPhone?: string | null;
}

export function buildReceptionDepartureData(input: BuildDepartureInput): DeliveryDepartureData {
  const { dispatched, result, cart, customerName, receiptPhone, orderDelivery, courierPhone } = input;
  return {
    consignmentNumber: dispatched.consignmentNumber,
    orderNumber: result.workOrders[0]?.orderNumber ?? (result.regularSale?.invoiceNumber ?? null),
    title: result.workOrders[0] ? `طلب #${result.workOrders[0].orderNumber}` : (cart[0]?.custom?.title ?? "طلب من الاستقبال"),
    customerName,
    customerPhone: receiptPhone,
    deliveryAddress: orderDelivery.address,
    courierName: orderDelivery.partyName,
    courierPhone,
    codAmount: dispatched.codAmount,
    deliveryFee: orderDelivery.fee,
    feeCollection: orderDelivery.feeCollection,
  };
}
