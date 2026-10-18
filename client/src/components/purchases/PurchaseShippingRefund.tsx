import { Link } from "wouter";
import { fmtAr } from "@/lib/money";
import { fmtDate } from "@/lib/date";

type ShippingRefund = {
  receiptId: number;
  voucherNumber: string | null;
  amount: string;
  cashBucket: string | null;
  shiftId: number | null;
  occurredAt: Date | string;
};

export function PurchaseShippingRefund({ refund }: { refund?: ShippingRefund | null }) {
  if (!refund) return null;
  return (
    <div className="space-y-1 border-t pt-2 text-xs">
      <p>
        استرداد فعلي للشحن: <strong>{fmtAr(refund.amount)} د.ع</strong>
        {refund.cashBucket === "DRAWER" ? ` إلى درج الوردية #${refund.shiftId}`
          : refund.cashBucket === "TREASURY" ? " إلى الخزينة" : " بطريقة غير نقدية"}
        {` · ${fmtDate(refund.occurredAt)}`}
      </p>
      {refund.voucherNumber ? (
        <Link href={`/vouchers?search=${encodeURIComponent(refund.voucherNumber)}`} className="text-primary hover:underline">
          سند قبض الاسترداد: {refund.voucherNumber}
        </Link>
      ) : <span>إيصال استرداد #{refund.receiptId}</span>}
    </div>
  );
}
