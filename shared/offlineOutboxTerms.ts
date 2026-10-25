export const OFFLINE_OUTBOX_STATUS_LABEL = {
  QUEUED: "بانتظار المزامنة",
  SENDING: "قيد الترحيل",
  SENT: "تم الترحيل",
  PARKED: "معلق للمراجعة",
} as const;

export function offlineOutboxStatusLabel(status: string): string {
  return Object.hasOwn(OFFLINE_OUTBOX_STATUS_LABEL, status)
    ? OFFLINE_OUTBOX_STATUS_LABEL[
        status as keyof typeof OFFLINE_OUTBOX_STATUS_LABEL
      ]
    : status;
}
