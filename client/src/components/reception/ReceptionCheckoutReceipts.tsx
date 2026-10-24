import { receptionDocumentPaymentLegs } from "@/components/payments/receptionReceiptPayments";
import type { RouterOutputs } from "@/lib/trpc";
import type { OrderDeliveryValue } from "@/components/reception/ReceptionTypes";
import {
  receptionReceiptChange,
  receptionReceiptSettlements,
  receptionReceiptMethodLabel,
} from "@/lib/receptionReceiptSettlement";
import {
  type CustomizationData,
  composeCustomizationText,
} from "@/components/CustomizationDialog";
import { D, fmt, round2 } from "@/lib/money";
import { fmtDate, fmtTime } from "@/lib/date";
import { receptionCheckoutReceiptMeta } from "@/lib/printing/receptionReceiptMeta";
import {
  effectivePrice,
  lineTotal,
  PAY_METHOD_LABEL,
  type CartLine,
  type PayMethod,
} from "@/components/reception/cartMath";
import {
  type ReceiptBrowserData,
  type WorkOrderReceiptData,
} from "@/lib/printing/print";

export interface ReceptionCheckoutReceiptsInput {
  customerName: string | null;
  receiptPhone: string;
  method: import("@/components/reception/cartMath").PayMethod;
  inputPaidD: import("decimal.js").Decimal;
  expectedNowD: import("decimal.js").Decimal;
  appliedPaidD: import("decimal.js").Decimal;
  result:
    | RouterOutputs["workOrders"]["receptionCheckout"]
    | RouterOutputs["reception"]["draftCommit"];
  shift: RouterOutputs["shifts"]["current"];
  orderDelivery:
    | import("@/components/reception/ReceptionTypes").OrderDeliveryValue
    | null;
  printLines: import("@/components/reception/cartMath").CartLine[];
  regularLines: import("@/components/reception/cartMath").CartLine[];
  saleAmount: string;
  printAmount: string;
  checkoutPaymentMode: "PREPAID" | "COD" | "CREDIT";
  printedAt: Date;
  me: { data: RouterOutputs["auth"]["me"] | undefined };
  hasCarrierInvoice: boolean;
  invoiceDiscountAmountD: import("decimal.js").Decimal;
  customWithDeposits: {
    c: import("@/components/reception/cartMath").CartLine;
    depositStr: string;
    salePriceStr: string;
  }[];
  effectiveWoDelivery: (
    custom: import("@/components/CustomizationDialog").CustomizationData,
    idx: number,
  ) => {
    has: boolean;
    address: string | null;
    phone: string | null;
    cost: string;
    feeColl: "COURIER" | "COUNTER" | "SHOP";
    partyName: string | null;
  };
}
export function buildReceptionCheckoutReceipts({
  customerName,
  receiptPhone,
  method,
  inputPaidD,
  expectedNowD,
  appliedPaidD,
  result,
  shift,
  orderDelivery,
  printLines,
  regularLines,
  saleAmount,
  printAmount,
  checkoutPaymentMode,
  printedAt,
  me,
  hasCarrierInvoice,
  invoiceDiscountAmountD,
  customWithDeposits,
  effectiveWoDelivery,
}: ReceptionCheckoutReceiptsInput) {
  const receiptsToPrint: ReceiptBrowserData[] = [];
  const workOrdersToPrint: WorkOrderReceiptData[] = [];
  const receiptCustomerName =
    customerName && receiptPhone
      ? `${customerName} — ${receiptPhone}`
      : (customerName ?? (receiptPhone ? `عميل ${receiptPhone}` : null));
  // ش٤: الفكّة والمتبقّي يقاسان على المستحقّ الآن (بعد خصم العربون السابق heldD).
  const printedChange = result.paymentSummary ? (D(result.paymentSummary.changeAmount).gt(0) ? result.paymentSummary.changeAmount : null) : receptionReceiptChange(
    method,
    inputPaidD.toFixed(2),
    expectedNowD.toFixed(2),
  );
  const creditD = round2(expectedNowD.minus(appliedPaidD));
  const printedCredit = creditD.gt(0) ? creditD.toFixed(2) : null;
  const receiptLine = (c: CartLine) => ({
    name: `${c.row.productName} (${c.row.unitName})${c.disc ? ` −${c.disc}%` : ""}`,
    quantity: c.qty,
    price: round2(D(effectivePrice(c))).toFixed(2),
    total: round2(D(lineTotal(c))).toFixed(2),
  });
  // G3 (١١/٨) — إصلاح Codex P2:
  // (١) heldDeposits من ردّ الخادم لا الحالة المحلّية: `customWithDeposits[i].depositStr` مسوّدة
  //     "0.00" دائماً — الخادم يوزّع العرابين الحقيقيّة ويعيدها في `result.workOrders[i].deposit`
  //     (نفس النمط المستعمل أدناه لتذكرة أمر الشغل السطر ١٥٨٤).
  // (٢) shiftId من الفاتورة المُثبَّتة لا من scope الحيّ: عند idempotent replay بعد إغلاق الوردية
  //     الأصليّة وفتح جديدة، `result.regularSale.shiftId` يحمل رقم الوردية الحقيقيّة للفاتورة.
  //     الرجوع لـ`shift?.id` احتياطاً لمسار الأمر الشغل الخالص (لا فاتورة).
  const receiptServerMeta = receptionCheckoutReceiptMeta(result, shift?.id);
  const isCodSaleCarrier = Boolean(
    orderDelivery && printLines.length > 0 && regularLines.length > 0,
  );
  const appliedPayments =
    "appliedPayments" in result ? result.appliedPayments : undefined;
  const { regular: regularSettlement, print: printSettlement } =
    receptionReceiptSettlements({
      regular: result.regularSale
        ? { invoiceId: result.regularSale.invoiceId, total: saleAmount }
        : null,
      print: result.printSale
        ? { invoiceId: result.printSale.invoiceId, total: printAmount }
        : null,
      newlyPaid: appliedPaidD.toFixed(2),
      appliedPayments,
      printFirst: isCodSaleCarrier,
    });
  const receiptHead = {
    date: fmtDate(printedAt),
    time: fmtTime(printedAt),
    cashierName: me.data?.name ?? "موظف الخدمة",
    customerName: receiptCustomerName,
    shiftId: receiptServerMeta.shiftId,
    heldDeposits: receiptServerMeta.heldDeposits,
  };
  // ٨/٨ — إفصاح التوصيل على إيصال البيع المباشر: كان لا يُطبَع إطلاقاً («لم تظهر بالطباعة»).
  // يُوضَع على الفاتورة الحاملة للإرسالية (البضاعة إن وُجِدت وإلّا الطباعة). الأجرة تمريرٌ لا
  // إيراد ⇒ خارج الإجمالي؛ الإيصال يعرض «يدفع الزبون شاملاً التوصيل» شفافيةً.
  const receiptDelivery =
    orderDelivery && hasCarrierInvoice
      ? {
          partyName: orderDelivery.partyName ?? "",
          fee: round2(D(orderDelivery.fee || 0)).toFixed(2),
          feeCollection: orderDelivery.feeCollection,
          address: orderDelivery.address ?? null,
        }
      : null;
  if (result.regularSale) {
    // ٢٣/٨ — Codex P1: خصمُ رأس الفاتورة يُطبع صراحةً على الإيصال. لولا هذا يظهر subtotal
    // = total (الصافي) بينما الأسطر تُظهر أسعارها الخام ⇒ الإيصال لا يُطابق حسابياً والزبون يسأل
    // عن الفارق. `subtotal` صار الخام (`regularSumRawD`)، `discount` يعلن الخصم، والصافي `total`.
    const regularGrossD = regularLines.reduce(
      (s, c) => s.plus(D(lineTotal(c))),
      D(0),
    );
    receiptsToPrint.push({
      ...receiptHead,
      receiptNumber: result.regularSale.invoiceNumber,
      invoiceId: result.regularSale.invoiceId,
      items: regularLines.map(receiptLine),
      subtotal: round2(regularGrossD).toFixed(2),
      discount: invoiceDiscountAmountD.gt(0)
        ? invoiceDiscountAmountD.toFixed(2)
        : null,
      total: saleAmount,
      paid: regularSettlement!.paid,
      change: printedChange,
      credit: regularSettlement!.credit,
      paymentMode: checkoutPaymentMode,
      paymentLegs: receptionDocumentPaymentLegs(result, { invoiceId: result.regularSale.invoiceId }, regularSettlement!.paid),
      paymentMethod: receptionReceiptMethodLabel({
        settlement: regularSettlement!,
        methodLabel: result.paymentAllocations ? "موضح في تفصيل الدفعات" : PAY_METHOD_LABEL[method],
        paymentMode: checkoutPaymentMode,
      }),
      delivery: receiptDelivery,
    });
  }
  if (result.printSale) {
    receiptsToPrint.push({
      ...receiptHead,
      receiptNumber: result.printSale.invoiceNumber,
      invoiceId: result.printSale.invoiceId,
      items: printLines.map(receiptLine),
      subtotal: printAmount,
      total: printAmount,
      paid: printSettlement!.paid,
      change: result.regularSale ? null : printedChange,
      credit: printSettlement!.credit,
      paymentMode: checkoutPaymentMode,
      paymentLegs: receptionDocumentPaymentLegs(result, { invoiceId: result.printSale.invoiceId }, printSettlement!.paid),
      paymentMethod: receptionReceiptMethodLabel({
        settlement: printSettlement!,
        methodLabel: result.paymentAllocations ? "موضح في تفصيل الدفعات" : PAY_METHOD_LABEL[method],
        paymentMode: checkoutPaymentMode,
      }),
      delivery: result.regularSale ? null : receiptDelivery,
    });
  }

  customWithDeposits.forEach((x, index) => {
    const c = x.c;
    const custom = c.custom!;
    const finalText = composeCustomizationText(custom);
    const eff = effectiveWoDelivery(custom, index);
    // ش٤ (§١٠): العربون الموزَّع على الأمر من ردّ الخادم (الجشع الخادميّ هو الحقيقة) —
    // التذكرة تحمل «مدفوع مقدماً/المتبقّي عند الاستلام» فلا يخرج الزبون بورقةٍ لا تُثبت عربونه.
    const woDeposit =
      (result.workOrders[index] as { deposit?: string } | undefined)?.deposit ??
      "0.00";
    const woBalance = round2(D(x.salePriceStr).minus(D(woDeposit)));
    const parts = receptionDocumentPaymentLegs(result, { workOrderId: result.workOrders[index]?.workOrderId }, woDeposit);
    const paymentNote = parts?.length ? `تفصيل العربون: ${parts.map(part => `${part.method}: ${fmt(part.amount)} د.ع${part.reference ? ` (${part.reference})` : ""}`).join(" · ")}` : null;
    workOrdersToPrint.push({
      orderNumber: result.workOrders[index]?.orderNumber ?? "",
      orderDate: fmtDate(printedAt),
      dueDate: custom.dueDate || null,
      status: "RECEIVED",
      customerName,
      customerPhone: receiptPhone,
      jobTitle: custom.title.trim() || c.row.productName,
      quantity: c.qty,
      specs: finalText || null,
      total: x.salePriceStr,
      paidUpfront: Number(woDeposit) > 0 ? woDeposit : null,
      balanceDue: Number(woDeposit) > 0 ? woBalance.toFixed(2) : null,
      // ٥/٨ + ٨/٨ — أجرة التوصيل تُطبع صراحةً على التذكرة **خارج الإجمالي**، مع الجهة ومَن
      // يقبضها: يمنع سوءَ الفهم الذي كان يجعل الموظّف والزبون يظنّانها جزءاً من قيمة الطلب،
      // ويُظهر التوصيل حتى حين جاء من زرّ «توصيل هذا الطلب» (كان لا يُطبَع إطلاقاً قبل الإصلاح).
      notes: [(eff.has
        ? [
            `توصيل إلى: ${eff.address || "العنوان غير محدد"}`,
            eff.phone ? `هاتف المستلم: ${eff.phone}` : null,
            eff.partyName ? `جهة التوصيل: ${eff.partyName}` : null,
            D(eff.cost || 0).gt(0)
              ? `أجرة التوصيل ${fmt(eff.cost)} د.ع (${
                  eff.feeColl === "COUNTER"
                    ? "مقبوضة في الاستقبال أمانةً"
                    : eff.feeColl === "SHOP"
                      ? "على المكتبة — مجاناً للزبون"
                      : "يقبضها المندوب من الزبون عند الاستلام"
                }) — خارج قيمة الطلب`
              : "توصيل — بلا أجرة",
          ]
            .filter(Boolean)
            .join(" · ")
        : null), paymentNote].filter(Boolean).join(" · ") || null,
    });
  });

  return { printedChange, printedCredit, receiptsToPrint, workOrdersToPrint };
}
