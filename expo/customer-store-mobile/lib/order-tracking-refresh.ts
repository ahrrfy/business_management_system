export interface RefreshableOrderTracking {
  status: string;
  deliveryProgress?: {
    complete?: boolean;
    phase?: "RETURNED" | "AWAITING_REASSIGNMENT" | "RETURN_REQUESTED";
  };
}

/** Completion slows refresh; returns and reactivation can still change the order. */
export function orderTrackingRefreshInterval(
  order: RefreshableOrderTracking,
): number {
  return order.status === "CANCELLED" ||
    order.deliveryProgress?.complete === true
    ? 300_000
    : 30_000;
}

export function orderTrackingUnavailable(error: unknown): boolean {
  if (error == null) return true;
  if (typeof error !== "object") return false;
  const failure = error as { code?: unknown; httpStatus?: unknown };
  return (
    ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(
      String(failure.code ?? ""),
    ) || [401, 403, 404].includes(Number(failure.httpStatus))
  );
}

export const ORDER_TRACKING_UNAVAILABLE_MESSAGE =
  "تعذر عرض هذا الطلب بهذه الصلاحية. أعد التحقق من هاتفك أو استخدم رمز التتبع الصحيح من الجهاز الذي أُنشئ منه الطلب.";

export function orderTrackingGuidance(order: RefreshableOrderTracking): {
  description: string;
  step: number;
  delivered: boolean;
} {
  switch (order.deliveryProgress?.phase) {
    case "RETURNED":
      return {
        description:
          "أعيد الطلب إلى المكتبة. تواصل مع فريقنا لمتابعة الاسترجاع أو أي طلب جديد.",
        step: -1,
        delivered: false,
      };
    case "AWAITING_REASSIGNMENT":
      return {
        description:
          "أُلغي إسناد التوصيل السابق. طلبك بانتظار إسناده إلى جهة توصيل جديدة.",
        step: -1,
        delivered: false,
      };
    case "RETURN_REQUESTED":
      return {
        description:
          "سُجل طلب إعادة الشحنة وهي بانتظار استلام المكتبة. لم تكتمل إعادة الطلب بعد.",
        step: -1,
        delivered: false,
      };
  }
  const stages: Record<string, { description: string; step: number }> = {
    PENDING: {
      description:
        "وصل طلبك إلى المكتبة وهو بانتظار تأكيد الموظف للتوفر والعنوان قبل بدء التجهيز.",
      step: 0,
    },
    CONFIRMED: {
      description:
        "أكد الموظف طلبك. يبدأ تجهيز المنتجات الآن قبل تسليمها للتوصيل.",
      step: 1,
    },
    PROCESSING: {
      description:
        "يجري تجهيز طلبك الآن. ستظهر حالة التوصيل عند تسليمه للمندوب.",
      step: 1,
    },
    SHIPPED: {
      description: "طلبك في مرحلة التوصيل. سيكتمل عند استلامك المنتجات.",
      step: 2,
    },
    DELIVERED: {
      description:
        "تم تسجيل تسليم الطلب. تظهر حالة استلام المبلغ بحسب الحركات المسجلة.",
      step: 3,
    },
    CANCELLED: {
      description:
        "أُلغي الطلب. يمكنك تحديث حالته لاحقاً أو التواصل مع فريق المكتبة عند الحاجة.",
      step: -1,
    },
  };
  return {
    ...(stages[order.status] ?? {
      description:
        "تتم متابعة طلبك من فريق المكتبة. راجع الحالة لاحقاً أو تواصل معنا عند الحاجة.",
      step: -1,
    }),
    delivered: order.status === "DELIVERED",
  };
}
