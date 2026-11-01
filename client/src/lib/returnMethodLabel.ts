import { paymentMethodLabel } from "./paymentMethod";

/** Return settlements include non-cash outcomes that are not payment methods. */
export function returnMethodLabel(method: string | null | undefined): string {
  if (method === "CREDIT_OFFSET") return "تسوية الذمة";
  if (method === "STORE_CREDIT") return "رصيد المتجر";
  return paymentMethodLabel(method);
}
