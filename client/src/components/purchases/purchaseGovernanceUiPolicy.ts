export type GovernanceRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "STALE"
  | "CANCELLED";

export const GOVERNANCE_STATUS_LABEL: Record<GovernanceRequestStatus, string> =
  {
    PENDING: "بانتظار اعتماد مستقل",
    APPROVED: "معتمد ومطبّق",
    REJECTED: "مرفوض بلا أثر",
    STALE: "منتهي الصلاحية بلا أثر",
    CANCELLED: "ملغى بلا أثر",
  };

export function governanceStatusLabel(status: string): string {
  return GOVERNANCE_STATUS_LABEL[status as GovernanceRequestStatus] ?? status;
}

export function governanceDecisionMessage(status: string): string {
  if (status === "APPROVED") return "تم الاعتماد وتطبيق الأثر داخل المعاملة";
  if (status === "REJECTED")
    return "تم رفض الطلب وتسجيل السبب بلا أثر تشغيلي أو مالي";
  if (status === "STALE")
    return "أُغلق الطلب لأن نسخة المستند تغيّرت، ولم يُطبّق أي أثر";
  return "حُفظت نتيجة القرار ولم يُسجّل أثر تنفيذي";
}

export function canReviewGovernanceRequest(
  currentUserId: number | null | undefined,
  requestedBy: number | string | null | undefined,
): boolean {
  if (currentUserId == null || requestedBy == null) return false;
  return Number(currentUserId) !== Number(requestedBy);
}

export function newGovernanceKey(scope: string): string {
  return `${scope}-${crypto.randomUUID()}`;
}
