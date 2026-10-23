import { isBaghdadGovernorate } from "@shared/governorates";

export function storefrontShippingThreshold(governorate: string, baghdad?: string | null, other?: string | null): number {
  const configured = isBaghdadGovernorate(governorate) ? baghdad : other ?? baghdad;
  const amount = Number(configured ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
