import type { PaymentMethod } from "./posShared";
/** Goods amount remains unchanged; the first payment leg also funds the separate fee allocation. */
export function deliveryFeeTenderForGoods(method: PaymentMethod) {
  if (method === "CHECK") throw new Error("الصك غير متاح لقبض أجرة التوصيل");
  return { method, combinedWithPaymentIndex: 0 };
}
