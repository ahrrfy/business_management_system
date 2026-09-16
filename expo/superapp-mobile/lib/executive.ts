export type DecisionSeverity = "critical" | "warning" | "info";

export type ExecutiveDecision = {
  id: string;
  severity: DecisionSeverity;
  title: string;
  context: string;
  actionLabel: string;
};

export type OwnerDecisionCenter = {
  asOf: string;
  scopeLabel: string;
  health: "healthy" | "degraded";
  decisions: ExecutiveDecision[];
  metrics: {
    label: string;
    value: string;
    detail: string;
    available: boolean;
  }[];
};

export const ownerDecisionCenterPreview: OwnerDecisionCenter = {
  asOf: "2026-09-09T09:30:00.000Z",
  scopeLabel: "جميع الفروع",
  health: "healthy",
  decisions: [
    {
      id: "approval-42",
      severity: "critical",
      title: "اعتماد مالي بانتظارك",
      context: "طلب تسوية يحتاج مراجعة قبل إغلاق اليوم.",
      actionLabel: "عرض التفاصيل",
    },
    {
      id: "receivable-17",
      severity: "warning",
      title: "ذمم متأخرة تحتاج متابعة",
      context: "توجد فواتير تجاوزت موعد التحصيل المتفق عليه.",
      actionLabel: "مراجعة الذمم",
    },
    {
      id: "inventory-8",
      severity: "info",
      title: "أصناف قريبة من حد إعادة الطلب",
      context: "تحقق من المخزون قبل دورة الشراء التالية.",
      actionLabel: "فتح المخزون",
    },
  ],
  metrics: [
    { label: "مبيعات اليوم", value: "2,480,000 د.ع", detail: "36 فاتورة", available: true },
    { label: "رصيد الخزينة", value: "1,120,000 د.ع", detail: "آخر تسوية اليوم", available: true },
    { label: "مخزون منخفض", value: "12 صنف", detail: "يحتاج متابعة", available: true },
  ],
};

export function visibleDecisions(decisions: ExecutiveDecision[], expanded: boolean): ExecutiveDecision[] {
  return expanded ? decisions : decisions.slice(0, 3);
}
