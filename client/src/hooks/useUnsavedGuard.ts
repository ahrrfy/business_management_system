import { useEffect } from "react";

/**
 * حارس فقدان البيانات — يعترض إغلاق التبويب/التحديث/المغادرة الخارجية حين يحمل النموذج
 * تغييرات غير محفوظة، عبر حدث `beforeunload` القياسي (يُظهر المتصفّح حوار «مغادرة؟»).
 *
 * ⚠️ نطاقه: يغطّي التحديث (refresh)، إغلاق التبويب، والمغادرة إلى موقع خارجيّ — وهي أكثر
 * أسباب الفقدان العرضيّ شيوعاً. لا يعترض تنقّل SPA الداخليّ (نقر رابط في الشريط الجانبي عبر
 * wouter)، إذ لا يُطلق `beforeunload`؛ اعتراض تنقّل الموجّه الداخليّ متابعةٌ لاحقة.
 *
 * مرّر `isDirty` محافِظاً (صحيح فقط حين أدخل المستخدم بياناتٍ فعلية) لتجنّب تحذيرٍ كاذب يُدرّب
 * المستخدم على تجاهله.
 */
export function useUnsavedGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      // مطلوب في بعض المتصفّحات كي يظهر حوار التأكيد.
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);
}
