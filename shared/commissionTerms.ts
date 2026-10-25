/** Settlement labels apply to commission runs and the employee's own performance history. */
export const COMMISSION_STATUS_LABEL = {
  draft: "قيد المراجعة",
  approved: "معتمدة",
} as const;

export function commissionStatusLabel(status: string): string {
  return Object.hasOwn(COMMISSION_STATUS_LABEL, status)
    ? COMMISSION_STATUS_LABEL[status as keyof typeof COMMISSION_STATUS_LABEL]
    : status;
}
