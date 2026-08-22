export type StudioScope = "QUEUE" | "MINE" | "REVIEW" | "HISTORY";
export type MobileStudioPanel = "LIST" | "DETAIL";
export type StudioReviewImage = "original" | "candidate";

export function defaultStudioScope(access: { canManage: boolean; canAudit: boolean }): StudioScope {
  if (access.canManage) return "QUEUE";
  return access.canAudit ? "HISTORY" : "MINE";
}

export function mobileStudioPanel(selectedTaskId: number | null): MobileStudioPanel {
  return selectedTaskId == null ? "LIST" : "DETAIL";
}

export function findScannedOwnedTask<T extends { productId: number | null }>(tasks: T[], productId: number): T | undefined {
  return tasks.find((task) => Number(task.productId) === productId);
}

export function toggleStudioReviewImage(current: StudioReviewImage): StudioReviewImage {
  return current === "original" ? "candidate" : "original";
}

export function adjustStudioReviewZoom(current: number, direction: "in" | "out"): number {
  const step = direction === "in" ? 0.25 : -0.25;
  return Math.min(3, Math.max(0.5, Math.round((current + step) * 100) / 100));
}

export const STUDIO_REJECTION_PRESETS = [
  "الخلفية لا تطابق صورة المنتج.",
  "المنتج غير واضح أو مقصوص.",
  "تفاصيل المنتج أو كتابته لا تطابق الأصل.",
] as const;
