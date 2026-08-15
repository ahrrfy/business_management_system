/**
 * سياسة أثر حالة الإيصال في الرصيد التاريخي.
 * COMPLETED حركة نافذة، وREVERSED يبقى ضمن الجمع لأن العكس الصحيح يملك إيصالاً تعويضياً
 * مستقلاً فيتصفّر الزوج. PENDING/FAILED أو أي إيصال غير APPROVED لم يتحقق مالياً
 * وأثره النقدي صفر، حتى لو حمل حالة COMPLETED/REVERSED.
 */
export function receiptStatusAffectsCash(
  status: string,
  approvalStatus: string,
): boolean {
  return (
    approvalStatus === "APPROVED" &&
    (status === "COMPLETED" || status === "REVERSED")
  );
}

export function receiptAffectsDrawerCash(receipt: {
  paymentMethod: string;
  cashBucket: string | null;
  status: string;
  approvalStatus: string;
}): boolean {
  return (
    receipt.paymentMethod === "CASH" &&
    receipt.cashBucket === "DRAWER" &&
    receiptStatusAffectsCash(receipt.status, receipt.approvalStatus)
  );
}
