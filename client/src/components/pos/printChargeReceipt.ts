import type { CheckoutChargesResult } from "@shared/checkoutCharges";
import { D } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { fmtDate } from "@/lib/date";
import { fmt } from "@/lib/printing/brand";
import {
  printDoc,
  type PrintDoc,
  type PrintResult,
  type PrintWindowOptions,
} from "@/lib/printing/print";
import { formatArabicMoneyWords } from "@/lib/printing/tafqit";

export function buildCheckoutAllocationReceiptDoc(
  result: CheckoutChargesResult,
  recoveryToken: string,
): PrintDoc {
  const chargeIds = Array.from(
    new Set(result.chargeAllocations.map((row) => row.chargeId)),
  );
  const docNum =
    chargeIds.length === 1
      ? `CHG-${chargeIds[0]}`
      : result.checkoutReceipts[0]
        ? `RCP-${result.checkoutReceipts[0].receiptId}`
        : recoveryToken;
  const applied = D(result.checkoutPaymentSummary.appliedAmount).toFixed(2);
  const change = D(result.checkoutPaymentSummary.changeAmount).toFixed(2);
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "إيصال قبض موحد",
    subtitle: chargeIds.length === 1 ? `رسوم CHG-${chargeIds[0]}` : `مرجع ${docNum}`,
    meta: [
      `رقم السند: ${docNum}`,
      `مرجع الاسترجاع: ${recoveryToken}`,
      `وقت القبض: ${fmtDate(new Date())}`,
    ],
    columns: ["التخصيص", "الوسيلة", "المبلغ"],
    rows: result.checkoutReceipts.map((row) => [
      row.kind === "DEPOSIT"
        ? `عربون (#${row.receiptId})`
        : row.kind === "GOODS"
          ? `بضاعة (#${row.receiptId})`
          : row.kind === "HELD_DELIVERY"
            ? `أمانة توصيل (#${row.receiptId})`
            : `أجور ${result.chargeAllocations
                .filter((a) => a.receiptId === row.receiptId)
                .map((a) => `CHG-${a.chargeId}`)
                .join("، ")}`,
      paymentMethodLabel(row.method),
      `${fmt(D(row.amount).toFixed(2))} د.ع`,
    ]),
    totals: [
      ...(D(change).gt(0)
        ? [{ label: "الباقي النقدي", value: `${fmt(change)} د.ع` }]
        : []),
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(applied) },
      { label: "المقبوض الفعلي", value: `${fmt(applied)} د.ع` },
    ],
    footer: "شكراً لتعاملكم مع المكتبة العربية.",
    barcodeSet: /^[\x20-\x7E]+$/.test(docNum)
      ? {
          barcode128: docNum,
          qrPayload: "",
          displayLabel: `إيصال قبض موحد — ${docNum}`,
        }
      : undefined,
  };
}

export function printCheckoutAllocationReceipt(
  result: CheckoutChargesResult,
  recoveryToken: string,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildCheckoutAllocationReceiptDoc(result, recoveryToken), options);
}
