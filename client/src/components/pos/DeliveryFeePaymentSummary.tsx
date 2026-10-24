import { fmt } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
export function DeliveryFeePaymentSummary({amount,method}:{amount:number;method:string}) {
  if (amount <= 0) return null;
  return <div className="border-y bg-muted/30 px-3 py-2 text-xs" role="status">
    <span>أمانة أجرة التوصيل: <strong dir="ltr">{fmt(amount)} د.ع</strong> — {paymentMethodLabel(method)}</span>
    <p className="mt-1 text-muted-foreground">تُضاف إلى عملية الدفع نفسها، وتبقى منفصلة عن تسديد البضاعة. {method === "CASH" ? "تدخل الدرج نقداً." : "لا تؤثر في نقد الدرج."}</p>
  </div>;
}
