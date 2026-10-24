import type { PaymentMethod } from "./posShared";
/** Link the fee to the first goods leg only when that leg is actually submitted. */
export function deliveryFeeTenderForGoods(method: PaymentMethod, hasGoodsPayment = true) {
  if (method === "CHECK") throw new Error("الصك غير متاح لقبض أجرة التوصيل");
  return { method, ...(hasGoodsPayment ? { combinedWithPaymentIndex: 0 } : {}) };
}
