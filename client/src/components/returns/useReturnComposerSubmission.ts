import type { ReturnComposerSubmissionContext } from "./returnComposerSubmissionTypes";
import { useReturnComposerExpressReturn } from "./useReturnComposerExpressReturn";
import { confirm } from "@/lib/confirm";
import { fmt, formatQuantity, round2 } from "@/lib/money";

import { REFUND_RAIL_LABEL } from "@shared/refundRails";

import { returnQuantityLabel } from "./returnComposerTypes";

export function useReturnComposerSubmission(
  ctx: ReturnComposerSubmissionContext,
) {
  const {
    me,
    operationPermission,
    executesImmediately,
    restock,
    reason,
    setError,
    setDone,
    clientRequestId,
    inv,
    isWalkIn,
    isDeliveryReversal,
    itemsById,
    pickedRail,
    method,
    shiftId,
    cardReference,
    usesTreasury,
    refundD,
    selectedLines,
    approve,
    create,
    noRefundNeeded,
    blockReason,
    approvingRequestId,
  } = ctx;

  async function submit() {
    setError("");
    setDone("");
    if (!operationPermission.allowed) {
      setError(operationPermission.reason);
      return;
    }
    if (!inv || blockReason) return;

    const refund =
      !isWalkIn && refundD.gt(0)
        ? {
            amount: round2(refundD).toFixed(2),
            method,
            ...(method === "CASH" && shiftId != null ? { shiftId } : {}),
            ...(method === "CARD" && cardReference.trim()
              ? { reference: cardReference.trim() }
              : {}),
          }
        : undefined;
    const resolution = isWalkIn
      ? {
          kind: "IMMEDIATE_REFUND" as const,
          method,
          amount: round2(refundD).toFixed(2),
          ...(method === "CASH" && shiftId != null && !noRefundNeeded
            ? { shiftId }
            : {}),
          ...(method === "CARD" && refundD.gt(0) && cardReference.trim()
            ? { reference: cardReference.trim() }
            : {}),
          reason: reason.trim(),
          disposition: restock ? ("RESTOCK" as const) : ("DAMAGED" as const),
        }
      : undefined;

    const railLabel = pickedRail
      ? REFUND_RAIL_LABEL[pickedRail]
      : REFUND_RAIL_LABEL.DRAWER;
    const cashSource = usesTreasury ? "من خزينة الفرع" : "من الدرج المحدّد";
    const moneySentence = resolution
      ? refundD.gt(0)
        ? `يسترد الزبون العابر ${fmt(resolution.amount)} د.ع ${method === "CASH" ? cashSource : `عبر ${railLabel}`}${isDeliveryReversal ? "، وتُعكس عهدة التوصيل عن الباقي آلياً" : ""}`
        : isDeliveryReversal
          ? "بلا إرجاع نقود؛ تُعكس عهدة التوصيل آلياً"
          : "بلا إرجاع نقود؛ لم يُقبض ما يستوجب الرد"
      : refund
        ? `يستلم الزبون ${fmt(refund.amount)} د.ع عبر ${railLabel}`
        : isDeliveryReversal
          ? "بلا إرجاع نقود؛ تُعكس عهدة التوصيل آلياً"
          : "بلا إرجاع نقود (تُخصَم من ذمّة العميل فقط)";
    const stockSentence = restock
      ? "والبضاعة تعود للرفّ"
      : "والبضاعة تالفة لا تعود للمخزون";
    const quantities = selectedLines.map((line) => {
      const item = itemsById.get(line.invoiceItemId);
      return item
        ? `${item.productName}: ${returnQuantityLabel(
            line.baseQuantity,
            item.conversionFactor,
            item.unitName,
            item.baseUnitName,
          )}`
        : `${formatQuantity(line.baseQuantity)} وحدة`;
    });
    const scope = `${selectedLines.length === 1 ? "صنفٌ واحد" : `${selectedLines.length} أصناف`} (${quantities.join("، ")})`;

    /**
     * ⭐ حوارُ التأكيد يقول الحقيقة (تدقيق ١/٩/٢٦ — بلاغ «المرتجع وهميّ»).
     * كان يُعنوَن «مرتجع الفاتورة» وزرُّه «تسجيل المرتجع» ويصف تسليم النقود وعودة البضاعة
     * للرفّ **بصيغة الحاضر** — بينما `returns.create` طلبٌ صفريّ الأثر لا يُنفَّذ حتى يعتمده
     * مراجعٌ مستقل. فيسلّم الموظّف البضاعة والنقود على وعدٍ لم يقع. المسار الوحيد الذي
     * ينفّذ فوراً هو اعتماد طلبٍ قائم (`approvingRequestId`).
     */
    if (
      !(await confirm({
        variant:
          approvingRequestId || executesImmediately ? "danger" : "warning",
        title: approvingRequestId
          ? `اعتماد وتنفيذ مرتجع الفاتورة ${inv.invoiceNumber}`
          : executesImmediately
            ? `تنفيذ مرتجع الفاتورة ${inv.invoiceNumber} الآن`
            : `إرسال طلب مرتجع للفاتورة ${inv.invoiceNumber}`,
        description:
          approvingRequestId || executesImmediately
            ? `يُنفَّذ الأثر الآن: ترجع ${scope} — ${moneySentence}، ${stockSentence}.${executesImmediately && !approvingRequestId ? (me.data?.isOwner ? " تنفيذٌ فوريّ بصفتك المالك، موثَّقٌ بسببه في سجلّ التدقيق." : " تنفيذٌ فوريّ ذريّ، موثَّقٌ بسببه في سجلّ التدقيق.") : ""} متابعة؟`
            : `ترسل طلباً بإرجاع ${scope} — وعند الاعتماد ${moneySentence}، ${stockSentence}.\n\nتنبيه: لا تسلّم الزبون نقوداً ولا تستلم البضاعة على هذا الطلب: لا يتغيّر المخزون ولا المال حتى يعتمده مراجعٌ مستقل (غيرك وغير منشئ الفاتورة).`,
        confirmText: approvingRequestId
          ? "اعتماد وتنفيذ"
          : executesImmediately
            ? "تنفيذ المرتجع"
            : "إرسال الطلب للاعتماد",
      }))
    )
      return;

    if (approvingRequestId) {
      approve.mutate({
        requestId: approvingRequestId,
        refund,
        resolution,
        ...(!isWalkIn ? { restock } : {}),
        clientRequestId,
      });
      return;
    }
    create.mutate({
      invoiceId: inv.id,
      lines: selectedLines,
      refund,
      resolution,
      ...(!isWalkIn ? { restock } : {}),
      reason: reason.trim(),
      clientRequestId,
      directExecution: executesImmediately,
    });
  }

  /**
   * ⭐ إرجاع فوري ذكي لكامل الفاتورة بنقرة واحدة (One-Click Express Return)
   * يملأ كافة البنود، يضع سبباً نظامياً تلقائياً، يحسب التسوية الذرية ويعرض تأكيداً واحداً شاملاً.
   */

  const { triggerExpressReturn } = useReturnComposerExpressReturn(ctx);
  return { submit, triggerExpressReturn };
}
