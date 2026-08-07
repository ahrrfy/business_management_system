export type PwaUpdateAction = "ACTIVATE_WAITING" | "RELOAD_ACTIVE" | "CHECK_AGAIN" | "UNAVAILABLE";

export type PwaRegistrationState = {
  hasRegistration: boolean;
  hasWaitingWorker: boolean;
  hasActiveWorker: boolean;
  updateWasSignaled: boolean;
};

/**
 * يحدد الإجراء من حالة التسجيل الفعلية، لا من وجود البنر وحده.
 *
 * قد يبلغ Workbox عن تحديث في تبويب لم يسيطر عليه العامل القديم. في هذه الحالة
 * يتفعّل العامل الجديد مباشرةً ولا يبقى `registration.waiting`؛ إرسال
 * SKIP_WAITING يصبح no-op، والحل الصحيح هو إعادة تحميل التبويب تحت العامل
 * الفعّال الجديد.
 */
export function decidePwaUpdateAction(state: PwaRegistrationState): PwaUpdateAction {
  if (!state.hasRegistration) return "UNAVAILABLE";
  if (state.hasWaitingWorker) return "ACTIVATE_WAITING";
  if (state.updateWasSignaled && state.hasActiveWorker) return "RELOAD_ACTIVE";
  return "CHECK_AGAIN";
}
