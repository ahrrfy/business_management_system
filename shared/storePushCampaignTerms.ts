/** Persisted campaign states; transactional campaigns are created by order events. */
export const STORE_PUSH_CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  DRAFT: "مسودة",
  APPROVED: "معتمدة",
  SCHEDULED: "مجدولة",
  RUNNING: "قيد الإرسال",
  COMPLETED: "مكتملة",
  CANCELLED: "ملغاة",
};
