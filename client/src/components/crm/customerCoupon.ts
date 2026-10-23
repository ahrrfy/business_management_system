import { D, fmt } from "@/lib/money";
export type DossierCoupon = {
  code: string;
  discountType?: string | null;
  discountAmount?: string | number | null;
  discountPercent?: string | number | null;
  programName?: string | null;
  validTo?: string | Date | null;
};
export function canPrintFixedCoupon(coupon: DossierCoupon): boolean {
  return (
    coupon.discountType !== "PERCENT" &&
    coupon.discountType !== "PERCENTAGE" &&
    D(coupon.discountPercent ?? 0).lte(0) &&
    D(coupon.discountAmount ?? 0).gt(0)
  );
}
export function couponDiscountLabel(coupon: DossierCoupon): string {
  return coupon.discountType === "PERCENT" ||
    coupon.discountType === "PERCENTAGE" ||
    D(coupon.discountPercent ?? 0).gt(0)
    ? fmt(coupon.discountPercent ?? 0) + "%"
    : fmt(coupon.discountAmount ?? 0) + " د.ع";
}
