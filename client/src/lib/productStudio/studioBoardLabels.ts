/**
 * قرارات العرض في لوحة استوديو المنتجات، مستخرَجةً من JSX كي تُختبَر فعلاً.
 *
 * الدافع: الحالة `ASSIGNED` مُحمَّلة بمعنيين — «مهمة طابور حملة بلا منفّذ» و«مهمة سُلّمت
 * لموظف» — فكانت الشاشة تسم الطابور «مسندة» وتعُدّه «قيد العمل»، بينما السطر التالي
 * يقول «المسؤول: غير مسند». المنطق هنا يفصل المعنيين في موضعٍ واحد قابل للاختبار.
 */

export type StudioBoardStatus = "ASSIGNED" | "IN_PROGRESS" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "FAILED" | "REVERTED";

/** المهمة في الطابور: حالتها ASSIGNED ولا منفّذ لها. */
export function isQueuedStudioTask(task: { status: StudioBoardStatus; assigneeName?: string | null }): boolean {
  return task.status === "ASSIGNED" && task.assigneeName == null;
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
