/**
 * سياسة أثر حالة الإيصال في الرصيد التاريخي.
 * COMPLETED حركة نافذة، وREVERSED يبقى ضمن الجمع لأن العكس الصحيح يملك إيصالاً تعويضياً
 * مستقلاً فيتصفّر الزوج. PENDING/FAILED لم يتحققا مالياً وأثرهما النقدي صفر.
 */
export function receiptStatusAffectsCash(status: string): boolean {
  return status === "COMPLETED" || status === "REVERSED";
}

export function receiptAffectsDrawerCash(receipt: {
  paymentMethod: string;
  cashBucket: string | null;
  status: string;
}): boolean {
  return (
    receipt.paymentMethod === "CASH" &&
    receipt.cashBucket === "DRAWER" &&
    receiptStatusAffectsCash(receipt.status)
  );
}
