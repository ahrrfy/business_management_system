import { confirm } from "@/lib/confirm";
import { D, fmt, round2 } from "@/lib/money";
import { computeReturnTotal } from "@/lib/returnTotal";
import { notify } from "@/lib/notify";
import { REFUND_RAIL_LABEL } from "@shared/refundRails";
import { refundDueAfterReturn } from "@shared/predicates/invoiceRemaining";

import type { ReturnComposerSubmissionContext } from "./returnComposerSubmissionTypes";
export function useReturnComposerExpressReturn(
  ctx: ReturnComposerSubmissionContext,
) {
  const {
    operationPermission,
    executesImmediately,
    qty,
    setQty,
    restock,
    manualAmount,
    setManualAmount,
    railState,
    setRailState,
    reason,
    setReason,
    clientRequestId,
    inv,
    isWalkIn,
    isDeliveryReversal,
    items,
    pickedRail,
    method,
    shiftId,
    cardReference,
    usesTreasury,
    activeOption,
    approve,
    create,
    isLocked,
    pending,
    requiresExecutableRail,
    approvingRequestId,
  } = ctx;
  async function triggerExpressReturn() {
    if (!operationPermission.allowed || pending) {
      notify.err(
        !operationPermission.allowed
          ? operationPermission.reason
          : "يوجد طلب معلّق على الفاتورة؛ عالجه أولاً من البطاقة أعلاه.",
      );
      return;
    }
    if (isLocked) {
      notify.err("هذه الفاتورة مقفلة أو مرتجعة بالكامل.");
      return;
    }
    const eligible = items.filter((it) => it.remaining > 0);
    if (!eligible.length) {
      notify.err("لا توجد بنود قابلة للإرجاع في هذه الفاتورة.");
      return;
    }

    const fullQty: Record<number, number> = {};
    for (const it of eligible) {
      fullQty[it.invoiceItemId] = it.remaining;
    }
    const changedToFullSelection =
      manualAmount !== null ||
      eligible.some((it) => qty[it.invoiceItemId] !== it.remaining);
    setQty(fullQty);
    if (changedToFullSelection) {
      setManualAmount(null);
      setRailState(null);
    }

    const effectiveReason =
      reason.trim() || "إرجاع كامل الفاتورة — تسوية سريعة";
    if (!reason.trim()) {
      setReason(effectiveReason);
    }

    const fullReturnValue = inv
      ? D(computeReturnTotal(inv.items, fullQty, inv))
      : D(0);
    const fullCustomerOwedBack = refundDueAfterReturn(
      {
        total: inv?.total,
        paidAmount: isDeliveryReversal
          ? inv?.refundablePaidAmount
          : inv?.paidAmount,
        returnedTotal: inv?.returnedTotal,
      },
      fullReturnValue.toString(),
    );
    const fullRailCap = fullReturnValue.lte(D(activeOption?.cap ?? "0"))
      ? fullReturnValue
      : D(activeOption?.cap ?? "0");
    const fullSuggestedRefund = fullCustomerOwedBack.lt(fullRailCap)
      ? fullCustomerOwedBack
      : fullRailCap;
    const fullRefundAmount = fullSuggestedRefund.gt(0)
      ? fullSuggestedRefund.toFixed(2)
      : "0.00";
    const fullRefundD = D(fullRefundAmount);

    if (fullRefundD.gt(0) && requiresExecutableRail) {
      if (changedToFullSelection) {
        notify.info(
          "تم تجهيز كامل بنود الفاتورة وتحديث مصدر الصرف — اضغط التأكيد للتنفيذ الفوري.",
        );
        return;
      }
      const preparedAmount = railState?.preflight?.estimatedCashOut;
      const railPreparedForFullAmount =
        preparedAmount != null && D(preparedAmount).eq(fullRefundD);
      if (
        railState == null ||
        !railPreparedForFullAmount ||
        railState.loading
      ) {
        notify.info(
          "اختر مصدر ردّ المبلغ الظاهر، ثم اضغط الإرجاع الكامل مرةً أخرى.",
        );
        return;
      }
      if (railState.error) {
        notify.err(`تعذّر التحقق من مصدر الرد — ${railState.error}`);
        return;
      }
      if (railState.blockReason || !railState.selection) {
        notify.err(railState.blockReason ?? "حدّد من أين يخرج مبلغ الردّ.");
        return;
      }
    } else if (fullRefundD.gt(0) && railState?.blockReason) {
      notify.err(railState.blockReason);
      return;
    }

    const linesToSubmit = eligible.map((it) => ({
      invoiceItemId: it.invoiceItemId,
      baseQuantity: it.remaining,
    }));

    const fullRefund =
      !isWalkIn && fullRefundD.gt(0)
        ? {
            amount: round2(fullRefundD).toFixed(2),
            method,
            ...(method === "CASH" && shiftId != null ? { shiftId } : {}),
            ...(method === "CARD" && cardReference.trim()
              ? { reference: cardReference.trim() }
              : {}),
          }
        : undefined;

    const fullResolution = isWalkIn
      ? {
          kind: "IMMEDIATE_REFUND" as const,
          method,
          amount: round2(fullRefundD).toFixed(2),
          ...(method === "CASH" && shiftId != null && fullRefundD.gt(0)
            ? { shiftId }
            : {}),
          ...(method === "CARD" && fullRefundD.gt(0) && cardReference.trim()
            ? { reference: cardReference.trim() }
            : {}),
          reason: effectiveReason,
          disposition: restock ? ("RESTOCK" as const) : ("DAMAGED" as const),
        }
      : undefined;

    const totalPieces = linesToSubmit.reduce((s, l) => s + l.baseQuantity, 0);
    const railLabel = pickedRail
      ? REFUND_RAIL_LABEL[pickedRail]
      : REFUND_RAIL_LABEL.DRAWER;
    const cashSource = usesTreasury ? "من خزينة الفرع" : "من الدرج المفتوح";
    const moneySentence = fullResolution
      ? fullRefundD.gt(0)
        ? `استرداد ${fmt(fullResolution.amount)} د.ع ${method === "CASH" ? `نقداً ${cashSource}` : `عبر ${railLabel}`}${isDeliveryReversal ? " وعكس عهدة التوصيل عن الباقي" : ""}`
        : isDeliveryReversal
          ? "بلا استرداد مالي، مع عكس عهدة التوصيل آلياً"
          : "بلا استرداد مالي؛ لم يُقبض ما يستوجب الرد"
      : fullRefund
        ? `استرداد ${fmt(fullRefund.amount)} د.ع عبر ${railLabel}`
        : isDeliveryReversal
          ? "بلا إرجاع نقد، مع عكس عهدة التوصيل آلياً"
          : "بلا إرجاع نقد (تسوية ذمة العميل)";

    const confirmed = await confirm({
      variant: approvingRequestId || executesImmediately ? "danger" : "warning",
      title: approvingRequestId
        ? `اعتماد وتنفيذ الإرجاع الكامل للفاتورة ${inv?.invoiceNumber}`
        : executesImmediately
          ? `تنفيذ الإرجاع الكامل للفاتورة ${inv?.invoiceNumber} الآن`
          : `إرسال طلب إرجاع كامل للفاتورة ${inv?.invoiceNumber}`,
      description:
        approvingRequestId || executesImmediately
          ? `يُنفَّذ الأثر الآن: ترجع جميع البنود المتبقية (${linesToSubmit.length} صنف · ${totalPieces} قطعة) مع ${moneySentence}. متابعة؟`
          : `سيُرسل طلب إرجاع جميع البنود المتبقية (${linesToSubmit.length} صنف · ${totalPieces} قطعة) مع ${moneySentence}. لا تسلّم الزبون مالاً ولا تستلم البضاعة حتى يعتمد مراجعٌ مستقل الطلب.`,
      confirmText: approvingRequestId
        ? "اعتماد وتنفيذ فوراً"
        : executesImmediately
          ? "تنفيذ فوري مباشر"
          : "إرسال الطلب للاعتماد",
    });

    if (!confirmed) return;

    if (approvingRequestId) {
      approve.mutate({
        requestId: approvingRequestId,
        refund: fullRefund,
        resolution: fullResolution,
        ...(!isWalkIn ? { restock } : {}),
        clientRequestId,
      });
    } else if (inv) {
      create.mutate({
        invoiceId: inv.id,
        lines: linesToSubmit,
        refund: fullRefund,
        resolution: fullResolution,
        ...(!isWalkIn ? { restock } : {}),
        reason: effectiveReason,
        clientRequestId,
        directExecution: executesImmediately,
      });
    }
  }
  return { triggerExpressReturn };
}
