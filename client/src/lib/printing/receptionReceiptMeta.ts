import { D, round2 } from "@/lib/money";

export interface ReceptionCheckoutReceiptResult {
  regularSale?: { shiftId?: number | null } | null;
  printSale?: { shiftId?: number | null } | null;
  workOrders?: Array<{ deposit?: string | number | null }> | null;
}

/**
 * بيانات الإيصال التي لا يجوز اشتقاقها من حالة السلة المحلية بعد نجاح التثبيت:
 * الخادم هو مصدر حقيقة توزيع العرابين، والفاتورة المحفوظة هي مصدر حقيقة الوردية.
 */
export function receptionCheckoutReceiptMeta(
  result: ReceptionCheckoutReceiptResult,
  fallbackShiftId?: number | null,
): { shiftId: number | null; heldDeposits: string | null } {
  const heldDeposits = round2(
    (result.workOrders ?? []).reduce(
      (total, order) => total.plus(D(order.deposit)),
      D(0),
    ),
  );

  return {
    shiftId:
      result.regularSale?.shiftId ??
      result.printSale?.shiftId ??
      fallbackShiftId ??
      null,
    heldDeposits: heldDeposits.gt(0) ? heldDeposits.toFixed(2) : null,
  };
}
