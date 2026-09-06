/**
 * قرارات العرض في لوحة استوديو المنتجات، مستخرَجةً من JSX كي تُختبَر فعلاً.
 *
 * الدافع: الحالة `ASSIGNED` مُحمَّلة بمعنيين — «مهمة طابور حملة بلا منفّذ» و«مهمة سُلّمت
 * لموظف» — فكانت الشاشة تسم الطابور «مسندة» وتعُدّه «قيد العمل»، بينما السطر التالي
 * يقول «المسؤول: غير مسند». المنطق هنا يفصل المعنيين في موضعٍ واحد قابل للاختبار.
 */

export type StudioBoardStatus = "ASSIGNED" | "IN_PROGRESS" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "FAILED" | "REVERTED" | "CANCELLED";

export type StudioStatusBadgeVariant = "neutral" | "info" | "warning" | "success" | "danger";

export interface StudioStatusDisplay {
  label: string;
  variant: StudioStatusBadgeVariant;
}

const DEFAULT_STATUS_LABEL: Record<StudioBoardStatus, string> = {
  ASSIGNED: "بانتظار التصوير",
  IN_PROGRESS: "قيد العمل",
  PENDING_REVIEW: "بانتظار الاعتماد",
  APPROVED: "مكتملة ومعتمدة",
  REJECTED: "تحتاج تعديلاً",
  FAILED: "فشلت",
  REVERTED: "استُرجع الأصل",
  CANCELLED: "ملغاة",
};

const DEFAULT_STATUS_VARIANT: Record<StudioBoardStatus, StudioStatusBadgeVariant> = {
  ASSIGNED: "info",
  IN_PROGRESS: "info",
  PENDING_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  FAILED: "danger",
  REVERTED: "neutral",
  CANCELLED: "neutral",
};

/** المهمة في الطابور: حالتها ASSIGNED ولا منفّذ لها. */
export function isQueuedStudioTask(task: { status: StudioBoardStatus; assigneeName?: string | null }): boolean {
  return task.status === "ASSIGNED" && task.assigneeName == null;
}

/** العرض الموحّد لحالة المهمة: يميز طابور الانتظار عن المهمة المسندة فعلياً وعن المعتمدة */
export function getStudioTaskStatusDisplay(task: {
  status: StudioBoardStatus;
  assigneeName?: string | null;
  assignedTo?: number | null;
}): StudioStatusDisplay {
  if (isQueuedStudioTask(task)) {
    return { label: "في الطابور", variant: "warning" };
  }
  return {
    label: DEFAULT_STATUS_LABEL[task.status] ?? task.status,
    variant: DEFAULT_STATUS_VARIANT[task.status] ?? "neutral",
  };
}

/** Selection belongs to a review job, even when sibling jobs share a product. */
export function studioTaskSelection<T extends { id: number | string; status: StudioBoardStatus; assignedTo: number | null; assigneeName?: string | null }>(tasks: T[], selectedIds: ReadonlySet<number>) {
  const queuedTaskIds = tasks.filter(isQueuedStudioTask).map((task) => Number(task.id));
  const selectedTasks = tasks.filter((task) => selectedIds.has(Number(task.id)));
  return {
    queuedTaskIds,
    allQueuedSelected: queuedTaskIds.length > 0 && queuedTaskIds.every((id) => selectedIds.has(id)),
    selectedAssignedTaskIds: selectedTasks.filter((task) => task.assignedTo != null && ["ASSIGNED", "IN_PROGRESS", "REJECTED"].includes(task.status)).map((task) => Number(task.id)),
    selectedActiveTaskIds: selectedTasks.filter((task) => ["ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "REJECTED"].includes(task.status)).map((task) => Number(task.id)),
  };
}

/**
 * تسمية زرّ توليد المهام الناقصة.
 * الصفر الصريح كان يُطبَع أيضاً حين لا تُنفَّذ المعاينة (بلا حملة) أو حين تفشل،
 * فيقرأ المدير «لا ناقص» بينما الطابور مليء.
 */
export function backlogButtonSuffix(state: { campaignSelected: boolean; isError: boolean; isPending: boolean; count?: number; batchLimit?: number }): string {
  if (!state.campaignSelected) return "(اختر حملة)";
  if (state.isError) return "(تعذّرت المعاينة)";
  if (state.isPending) return "(…)";
  const count = state.count ?? 0;
  const batchLimit = state.batchLimit ?? 0;
  return batchLimit > 0 && count > batchLimit ? `(${count} — دفعة ${batchLimit})` : `(${count})`;
}

/**
 * هل يُسمح بالاعتماد؟ الاعتماد بلا معاينةٍ ظاهرة = نشر صورةٍ لم يرها المراجع.
 * جاهزية المخزن إعدادٌ ثابت لا نتيجة جلبٍ حيّ، فلا تكفي وحدها.
 */
export function canApproveStudioCandidate(state: { offline: boolean; storageDisabled: boolean; busy: boolean; reviewable: boolean; previewLoaded: boolean }): boolean {
  return !state.offline && !state.storageDisabled && !state.busy && state.reviewable && state.previewLoaded;
}
