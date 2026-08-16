import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";

export const WORK_ORDER_REFUND_REFERENCE_MIN = 3;
export const WORK_ORDER_REFUND_REFERENCE_MAX = 100;

export function normalizedRefundReference(value: string): string {
  return value.trim();
}

/** مرآة workordersManagerProcedure: roles=[manager] + workorders/FULL. */
export function canCancelWorkOrder(
  role: string | null | undefined,
  override: unknown,
): boolean {
  return !!role && moduleAccessAllowed(
    role,
    (override ?? null) as PermissionMap | null,
    "workorders",
    "FULL",
    ["manager"],
  );
}

export function refundReferenceError(value: string): string | null {
  const normalized = normalizedRefundReference(value);
  if (normalized.length < WORK_ORDER_REFUND_REFERENCE_MIN) {
    return "أدخل مرجع تنفيذ الاسترداد الخارجي من 3 محارف على الأقل";
  }
  if (normalized.length > WORK_ORDER_REFUND_REFERENCE_MAX) {
    return "مرجع تنفيذ الاسترداد الخارجي لا يتجاوز 100 محرف";
  }
  return null;
}

export function cancellationRefundNotice(
  pendingRefundReceiptIds: readonly number[] | null | undefined,
  replayed: boolean,
): { title: string; description: string; awaitingOwner: boolean } {
  const pendingCount = pendingRefundReceiptIds?.length ?? 0;
  if (pendingCount > 0) {
    return {
      title: replayed ? "أُعيد تحميل نتيجة الإلغاء" : "أُلغي الأمر وبقي ردّ العربون معلّقاً",
      description: pendingCount === 1
        ? "بانتظار اعتماد المالك بعد تنفيذ الاسترداد غير النقدي فعلياً؛ لم يُصرف مال ولم يُسجَّل قيد دفع بعد."
        : `بانتظار اعتماد المالك لـ${pendingCount} طلبات رد غير نقدية؛ لم يُصرف مال ولم تُسجَّل قيود دفع بعد.`,
      awaitingOwner: true,
    };
  }
  return {
    title: replayed ? "أُعيد تحميل نتيجة الإلغاء" : "أُلغي الأمر",
    description: "أُعيدت المواد للمخزون إن وُجدت، ولا يوجد رد غير نقدي ينتظر اعتماداً.",
    awaitingOwner: false,
  };
}

export function refundApprovalResult(replayed: boolean): string {
  return replayed
    ? "أُعيدت نتيجة الاعتماد السابق؛ لم يُنشأ قيد دفع مكرر."
    : "ثُبّت رد العربون وقيد الدفع بعد تأكيد التنفيذ الخارجي.";
}

export type WorkOrderRefundStatus = "NONE" | "PENDING" | "APPROVED";

export function durableRefundStatusNotice(
  status: WorkOrderRefundStatus,
  amount: string,
): { title: string; description: string; awaitingOwner: boolean } | null {
  if (status === "PENDING") {
    return {
      title: "ردّ العربون بانتظار اعتماد المالك",
      description: `المبلغ ${amount} د.ع معلّق بلا صرف أو قيد دفع حتى تأكيد التنفيذ الخارجي واعتماده.`,
      awaitingOwner: true,
    };
  }
  if (status === "APPROVED") {
    return {
      title: "تم تنفيذ واعتماد ردّ العربون",
      description: `ثُبّت ردّ ${amount} د.ع وإيصال الصرف وقيد الدفع المرتبط به.`,
      awaitingOwner: false,
    };
  }
  return null;
}
