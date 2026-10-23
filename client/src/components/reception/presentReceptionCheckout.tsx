import type { RouterOutputs } from "@/lib/trpc";
import { round2 } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { type LastSaleSummary } from "@/components/reception/cartMath";
import {
  printWorkOrderReceipt,
  type ReceiptBrowserData,
  type WorkOrderReceiptData,
} from "@/lib/printing/print";
export interface presentReceptionCheckoutInput {
  receiptsToPrint: import("@/lib/printing/printTemplates").ReceiptBrowserData[];
  printAuthorizedReceiptData: (
    rec: import("@/lib/printing/printTemplates").ReceiptBrowserData,
    reprint?: boolean,
  ) => Promise<
    | { via: "browser" | "server" | "thermal"; ok: true }
    | { via: "browser"; ok: false; reason: "popup-blocked" }
    | { ok: false; via: "browser" }
  >;
  workOrdersToPrint: import("@/lib/printing/workOrderRaster").WorkOrderReceiptData[];
  invoiceId: number | null;
  createdWoIds: number[];
  isReserve: boolean;
  result:
    | RouterOutputs["workOrders"]["receptionCheckout"]
    | RouterOutputs["reception"]["draftCommit"];
  setLastSale: React.Dispatch<
    React.SetStateAction<
      import("@/components/reception/cartMath").LastSaleSummary | null
    >
  >;
  effectiveGrandD: import("decimal.js").Decimal;
  printedChange: string | null;
  printedCredit: string | null;
  checkoutPaymentMode: "PREPAID" | "COD" | "CREDIT";
  setShowReceiptOverlay: React.Dispatch<React.SetStateAction<boolean>>;
  resetAfterCommittedWorkspace: () => boolean;
  utils: ReturnType<typeof trpc.useUtils>;
}
export async function presentReceptionCheckout({
  receiptsToPrint,
  printAuthorizedReceiptData,
  workOrdersToPrint,
  invoiceId,
  createdWoIds,
  isReserve,
  result,
  setLastSale,
  effectiveGrandD,
  printedChange,
  printedCredit,
  checkoutPaymentMode,
  setShowReceiptOverlay,
  resetAfterCommittedWorkspace,
  utils,
}: presentReceptionCheckoutInput) {
  let browserFallbacks = 0;
  let printFailures = 0;
  for (const receipt of receiptsToPrint) {
    try {
      const result = await printAuthorizedReceiptData(receipt);
      if (!result.ok) printFailures += 1;
      else if (result.via === "browser") browserFallbacks += 1;
    } catch {
      printFailures += 1;
    }
  }
  for (const workOrder of workOrdersToPrint) {
    try {
      const result = await printWorkOrderReceipt(workOrder);
      if (result.via === "browser") browserFallbacks += 1;
    } catch {
      printFailures += 1;
    }
  }

  // إفراغ + إشعار + تجديد idempotency key (نَجاح كامل فقط).
  const summary = [
    invoiceId ? `فاتورة #${invoiceId}` : null,
    createdWoIds.length > 0 ? `${createdWoIds.length} أمر شغل` : null,
  ]
    .filter(Boolean)
    .join(" + ");
  const printDescription =
    printFailures > 0
      ? `تم الحفظ، لكن تعذّرت طباعة ${printFailures} مستند`
      : browserFallbacks > 0
        ? "فُتحت نافذة الطباعة لأن الطابعة المباشرة غير متصلة"
        : "أُرسلت المستندات إلى الطابعة مباشرة";
  if (isReserve) {
    notify.ok(
      `تم تأكيد فاتورة الدفع عند الاستلام #${result.regularSale?.invoiceNumber ?? ""}`,
      "جاهزة للتسليم المباشر (/reception/handover) أو الإسناد للتوصيل (/reception/workflow)",
    );
  } else {
    notify.ok(`تمّ ${summary}`, printDescription);
  }
  // ش١ (§٨.٦): نافذة الإيصال — الفكّة بخطٍّ ضخم + أرقام المستندات + إعادة الطباعة (F9)،
  // ولافتةٌ تسمّي ما لم يُطبَع (كان يُبتلَع في toast عابرٍ بلا أيّ سبيلٍ لإعادة الطباعة).
  setLastSale({
    invoiceNumbers: [
      result.regularSale?.invoiceNumber,
      result.printSale?.invoiceNumber,
    ].filter(Boolean) as string[],
    workOrderNumbers: result.workOrders
      .map((o) => o.orderNumber)
      .filter(Boolean),
    totalStr: round2(effectiveGrandD).toFixed(2),
    changeStr: printedChange,
    creditStr: printedCredit,
    paymentMode: checkoutPaymentMode,
    receipts: receiptsToPrint,
    workOrders: workOrdersToPrint,
    printFailures,
  });
  setShowReceiptOverlay(true);
  resetAfterCommittedWorkspace();
  // تحديث القوائم.
  utils.workOrders.list.invalidate().catch(() => {});
  utils.shifts.current.invalidate().catch(() => {});

  return {};
}
