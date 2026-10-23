import { useMemo } from "react";
import { fmt } from "@/lib/money";
import { ReturnComposerProps } from "./returnComposerTypes";
import type { useReturnComposerState } from "./useReturnComposerState";
import type { useReturnComposerSettlement } from "./useReturnComposerSettlement";
export function useReturnComposerGuard(
  ctx: Pick<
    ReturnType<typeof useReturnComposerState> &
      ReturnType<typeof useReturnComposerSettlement> &
      ReturnComposerProps,
    | "refundRailPermission"
    | "executesImmediately"
    | "requestDetail"
    | "railState"
    | "reason"
    | "lockedLines"
    | "isWalkIn"
    | "returnValue"
    | "activeOption"
    | "railCap"
    | "refundD"
    | "hasIncompleteRefund"
    | "overCap"
    | "selectedLines"
    | "isLocked"
    | "pending"
    | "invoiceId"
    | "approvingRequestId"
  >,
) {
  const {
    refundRailPermission,
    executesImmediately,
    requestDetail,
    railState,
    reason,
    lockedLines,
    isWalkIn,
    returnValue,
    activeOption,
    railCap,
    refundD,
    hasIncompleteRefund,
    overCap,
    selectedLines,
    isLocked,
    pending,
    invoiceId,
    approvingRequestId,
  } = ctx;

  /**
   * مرتجعٌ بلا ردّ نقديّ (بلاغ المالك ١٨/٨) — فاتورةٌ لم يُقبض عليها دينار (آجلة/COD/عربونٌ
   * أقلّ) أو قيمةُ المرتجع تُغطّيها الذمّة: **لا مال يخرج**، فلا رافدَ ولا درجَ ولا مرجع.
   * الخادم يقبل هذا أصلاً (returnService: كتلة الردّ تُتخطّى عند صفر)، لكن الشاشة كانت تُعطّل
   * زرّ التأكيد كلّياً لأنّ كلا الرافدين «محجوب» حين يكون وعاء المقبوض صفراً — فيُقرأ ذلك
   * «النظام يجبرني على اختيار درجٍ لردّ نقودٍ لم تُقبض».
   */
  const noRefundNeeded = refundD.lte(0);

  const requiresExecutableRail = Boolean(
    approvingRequestId || executesImmediately,
  );

  /** سببُ تعطيل الحفظ — نصٌّ واحدٌ يُعرَض دائماً بدل رفضٍ متأخّر من الخادم. */
  const blockReason = useMemo(() => {
    if (hasIncompleteRefund)
      return "أكمل مبلغ الاسترداد أو اختر تقييد المرتجع بحساب العميل صراحةً.";
    if (isLocked)
      return "هذه الفاتورة مرتجعة/ملغاة — لا يمكن تسجيل مرتجع جديد.";
    if (
      approvingRequestId &&
      requestDetail.data &&
      requestDetail.data.invoiceId !== invoiceId
    ) {
      return "طلب المرتجع لا يعود إلى هذه الفاتورة — أُوقف الاعتماد حمايةً من تنفيذ طلب على مستند آخر.";
    }
    // لا اعتماد قبل أن تصل بنود الطلب — وإلّا اعتمد المدير على جدولٍ فارغ لا يمثّل ما سيُنفَّذ.
    if (approvingRequestId && !lockedLines)
      return "جارٍ تحميل بنود الطلب المطلوب اعتماده…";
    // طلبٌ معلّقٌ قائم ⇒ الخادم يرفض الثاني بالفهرس الفريد. نقولها هنا بدل خطأٍ خامّ بعد الملء.
    if (pending && !approvingRequestId) {
      return pending.isMine
        ? `طلبك #${pending.id} لم يُنفّذ؛ اسحبه من البطاقة أعلاه قبل إعداد طلب جديد.`
        : `على هذه الفاتورة طلبٌ معلّق #${pending.id} — راجعه من طلبات العمليات قبل إرسال طلبٍ جديد.`;
    }
    // The server preflight authorizes the selected drawer/treasury; a base-role check
    // here would reject owners and permitted alternative drawers before that decision.
    if (!selectedLines.length) return "حدّد كمية إرجاع واحدة على الأقل.";
    if (isWalkIn && !returnValue.gt(0))
      return "قيمة المرتجع صفر؛ لا يمكن إنشاء تسوية نقدية لزبون عابر.";
    if (
      requiresExecutableRail &&
      !noRefundNeeded &&
      refundD.gt(0) &&
      !refundRailPermission.allowed
    ) {
      return "لا تملك صلاحية التحقق من مصدر ردّ المبلغ؛ يمكنك اعتماد المرتجعات التي لا تتطلب صرفاً فقط.";
    }
    // حجبُ الرافد يسري على ردٍّ **موجب** فقط — لا معنى لسقفٍ حين لا يخرج مال.
    if (!noRefundNeeded && activeOption?.blockedReason)
      return activeOption.blockedReason;
    if (overCap)
      return `المبلغ يتجاوز المسموح (${fmt(railCap.toFixed(2))} د.ع).`;
    // مالٌ يخرج ⇒ الرافدُ والدرجُ والمرجعُ من المنتقي الموحَّد (عند التنفيذ/الاعتماد الفعلي).
    if (!noRefundNeeded && refundD.gt(0)) {
      if (requiresExecutableRail) {
        if (railState == null || railState.loading)
          return "جارٍ التحقق من روافد الردّ والأدراج المفتوحة…";
        if (railState.error)
          return `تعذّر التحقق من روافد الردّ — ${railState.error}`;
        if (railState.blockReason) return railState.blockReason;
        if (!railState.selection) return "حدّد من أين يخرج المال.";
      } else if (railState?.blockReason) {
        return railState.blockReason;
      }
    }
    if (reason.trim().length < 3)
      return "اكتب سبب المرتجع (٣ أحرف على الأقل) لتوثيق الطلب.";
    return null;
  }, [
    hasIncompleteRefund,
    isLocked,
    pending,
    approvingRequestId,
    requiresExecutableRail,
    requestDetail.data,
    invoiceId,
    lockedLines,
    selectedLines.length,
    isWalkIn,
    returnValue,
    noRefundNeeded,
    refundRailPermission.allowed,
    activeOption?.blockedReason,
    overCap,
    railCap,
    refundD,
    railState,
    reason,
  ]);
  return { noRefundNeeded, requiresExecutableRail, blockReason };
}
