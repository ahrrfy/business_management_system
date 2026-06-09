import VoucherFormShared from "@/pages/_VoucherFormShared";

/** سند قبض جديد — IN (المحلّ يَستلم نقداً/بطاقة/تحويلاً من طرف). */
export default function VoucherReceiptNew() {
  return <VoucherFormShared voucherType="RECEIPT" />;
}
