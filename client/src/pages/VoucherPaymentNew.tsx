import VoucherFormShared from "@/pages/_VoucherFormShared";

/** سند صرف جديد — OUT (المحلّ يَدفع لطرف خارجي بلا فاتورة). */
export default function VoucherPaymentNew() {
  return <VoucherFormShared voucherType="PAYMENT" />;
}
