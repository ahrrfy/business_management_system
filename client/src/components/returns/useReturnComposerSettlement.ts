import { useMemo } from "react";
import { D, moneyInput } from "@/lib/money";
import { computeReturnTotal } from "@/lib/returnTotal";
import { refundDueAfterReturn } from "@shared/predicates/invoiceRemaining";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { ReturnComposerProps } from "./returnComposerTypes";
import type { useReturnComposerState } from "./useReturnComposerState";
export function useReturnComposerSettlement(
  ctx: Pick<
    ReturnType<typeof useReturnComposerState> & ReturnComposerProps,
    | "withdrawControlPermission"
    | "withdrawLegacyPermission"
    | "qty"
    | "manualAmount"
    | "railState"
    | "inv"
    | "isWalkIn"
    | "isDeliveryReversal"
    | "approvingRequestId"
  >,
) {
  const {
    withdrawControlPermission,
    withdrawLegacyPermission,
    qty,
    manualAmount,
    railState,
    inv,
    isWalkIn,
    isDeliveryReversal,
    approvingRequestId,
  } = ctx;

  /** قيمة المرتجع — الصيغة في `lib/returnTotal` (مطابقةٌ لفرع الإرجاع الجزئيّ خادمياً، ومُختبَرة وحدها). */
  const returnValue = useMemo(
    () => (inv ? D(computeReturnTotal(inv.items, qty, inv)) : D(0)),
    [inv, qty],
  );

  /**
   * الرافدُ المختار في المنتقي ⇒ طريقةُ الردّ في عقد الخادم: الدرجُ والخزينةُ نقدٌ (`CASH`)،
   * والفرقُ بينهما درجٌ يُرسَل أو لا (بلا درجٍ يوجّه الخادمُ الإداريَّ إلى الخزينة).
   */
  const pickedRail = railState?.selection?.rail ?? null;

  const method: "CASH" | "CARD" = pickedRail === "CARD" ? "CARD" : "CASH";

  const shiftId =
    pickedRail === "DRAWER"
      ? (railState?.selection?.refundShiftId ?? null)
      : null;

  const cardReference = railState?.selection?.cardReference ?? "";

  const usesTreasury = pickedRail === "TREASURY";

  const options = inv?.refundOptions ?? [];

  // الزبون العابر لا يملك ذمّةً معلّقة؛ نعرض فقط رافدي الردّ الفوريّ المعتمدين.
  const visibleRefundOptions = isWalkIn
    ? options.filter(
        (option) => option.method === "CASH" || option.method === "CARD",
      )
    : options;

  const activeOption = options.find((o) => o.method === method);

  /** السقف الفعليّ = الأقلّ من قيمة المرتجع وسقف الرافد — **نفس معادلة الخادم حرفياً**. */
  const railCap = useMemo(() => {
    const cap = D(activeOption?.cap ?? "0");
    return returnValue.lte(cap) ? returnValue : cap;
  }, [activeOption?.cap, returnValue]);

  /**
   * المستحقّ للزبون فعلاً = ما دفعه فوق ما يبقى عليه **بعد** هذا المرتجع.
   * السقف وحده لا يكفي: هو يحرس «لا نردّ أكثر ممّا قبضنا» ولا يحرس «لا نردّ ما هو مستحقٌّ لنا».
   * فاتورةٌ آجلة بعربونٍ ٤٠٪ يُرجَع منها صنفٌ كان السقف يعرض ردّاً نقدياً كاملاً بنقرة، والعميل
   * ما زال مديناً — نُعطي نقداً لمن يدين لنا. الافتراضيّ صار الأقلّ منهما.
   */
  const customerOwedBack = useMemo(() => {
    return refundDueAfterReturn(
      {
        total: inv?.total,
        // `paidAmount` بعد تسليم COD يشمل عهدةً ما زالت بيد المندوب؛ الردّ من المتجر
        // لا يُحسب إلا من المقبوض الذي دخل المتجر فعلاً.
        paidAmount: isDeliveryReversal
          ? inv?.refundablePaidAmount
          : inv?.paidAmount,
        returnedTotal: inv?.returnedTotal,
      },
      returnValue.toString(),
    );
  }, [
    inv?.total,
    inv?.returnedTotal,
    inv?.paidAmount,
    inv?.refundablePaidAmount,
    isDeliveryReversal,
    returnValue,
  ]);

  /** الوجه المقابل: ما يبقى على العميل بعد المرتجع (صفرٌ إن صار دائناً). */
  const customerStillOwes = useMemo(() => {
    const netAfter = D(inv?.total ?? "0")
      .minus(D(inv?.returnedTotal ?? "0"))
      .minus(returnValue);
    const owes = netAfter.minus(D(inv?.paidAmount ?? "0"));
    return owes.gt(0) ? owes : D(0);
  }, [inv?.total, inv?.returnedTotal, inv?.paidAmount, returnValue]);

  /**
   * المبلغ المقترح للجميع هو الأقل من المستحق الفعلي ووعاء المقبوض. أمّا العابر فلا يحرره
   * الموظف: صفرٌ إن لم يُقبض شيء، والعربون وحده عند الإلغاء الكامل، لا قيمة الفاتورة.
   */
  const suggestedRefund = useMemo(
    () => (customerOwedBack.lt(railCap) ? customerOwedBack : railCap),
    [customerOwedBack, railCap],
  );

  const refundAmount = isWalkIn
    ? suggestedRefund.toFixed(2)
    : (manualAmount ??
      (suggestedRefund.gt(0) ? suggestedRefund.toFixed(2) : ""));

  const refundD = moneyInput(refundAmount);

  const hasIncompleteRefund =
    manualAmount !== null &&
    !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(refundAmount.trim());

  const overCap = refundD.gt(railCap);

  const selectedLines = useMemo(
    () =>
      Object.entries(qty)
        .map(([id, q]) => ({ invoiceItemId: Number(id), baseQuantity: q }))
        .filter((l) => l.baseQuantity > 0),
    [qty],
  );

  /** الكمّيات غير قابلة للتعديل في وضع الاعتماد: الخادم ينفّذ بنود الطلب لا إدخال المدير. */
  const qtyLocked = !!approvingRequestId;

  const isLocked = isDeadInvoiceStatus(inv?.status);

  /** الطلب المعلّق على هذه الفاتورة (الحوكميّ أو القديم) — الخادم مصدرُه، لا اشتقاقٌ في الشاشة. */
  const pending = inv?.pendingRequest ?? null;

  const canWithdrawPending =
    !!pending?.isMine &&
    (pending.source === "CONTROL"
      ? withdrawControlPermission.allowed
      : withdrawLegacyPermission.allowed);
  return {
    returnValue,
    pickedRail,
    method,
    shiftId,
    cardReference,
    usesTreasury,
    options,
    visibleRefundOptions,
    activeOption,
    railCap,
    customerOwedBack,
    customerStillOwes,
    suggestedRefund,
    refundAmount,
    refundD,
    hasIncompleteRefund,
    overCap,
    selectedLines,
    qtyLocked,
    isLocked,
    pending,
    canWithdrawPending,
  };
}
