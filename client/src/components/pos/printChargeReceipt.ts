import type { CheckoutChargesResult } from "@shared/checkoutCharges";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { formatIqd } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
export function printCheckoutAllocationReceipt(
  result: CheckoutChargesResult,
  recoveryToken: string,
) {
  const chargeIds=Array.from(new Set(result.chargeAllocations.map(row=>row.chargeId)));
  return printReportDoc({
    title: "إيصال قبض موحد",
    docNum:chargeIds.length===1?`CHG-${chargeIds[0]}`:null,
    headerExtra: [{ label: "مرجع الاسترجاع", value: recoveryToken }],
    columns: [
      { key: "receipt", label: "الإيصال" },
      { key: "kind", label: "التخصيص" },
      { key: "method", label: "الوسيلة" },
      { key: "amount", label: "المبلغ", align: "left" },
    ],
    rows: result.checkoutReceipts.map((row) => ({
      receipt: String(row.receiptId),
      kind:
        row.kind === "DEPOSIT" ? "عربون طلب" : row.kind === "GOODS"
          ? "بضاعة"
          : row.kind === "HELD_DELIVERY"
            ? "أمانة توصيل"
            : `أجور: ${result.chargeAllocations
                .filter((a) => a.receiptId === row.receiptId)
                .map((a) => `CHG-${a.chargeId}`)
                .join("، ")}`,
      method: paymentMethodLabel(row.method),
      amount: formatIqd(row.amount),
    })),
    summary: [
      {
        label: "المقبوض الفعلي",
        value: formatIqd(result.checkoutPaymentSummary.appliedAmount),
        bold: true,
      },
      {
        label: "الباقي النقدي",
        value: formatIqd(result.checkoutPaymentSummary.changeAmount),
      },
    ],
  });
}
