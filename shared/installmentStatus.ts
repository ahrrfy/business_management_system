/**
 * حالة خطة الأقساط وأسطرها — مصدر الحقيقة الموحَّد للتعريب وتنسيق الشارات.
 */

export const PLAN_STATUS_MAP: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "نشطة", cls: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" },
  COMPLETED: { label: "مكتملة", cls: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]" },
  CANCELLED: { label: "ملغاة", cls: "bg-muted text-muted-foreground" },
};

export const LINE_STATUS_MAP: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "معلَّق", cls: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]" },
  PAID: { label: "مسدَّد", cls: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]" },
  BOUNCED: { label: "صك مرتجع", cls: "bg-destructive/15 text-destructive" },
  CANCELLED: { label: "ملغى", cls: "bg-muted text-muted-foreground" },
};
