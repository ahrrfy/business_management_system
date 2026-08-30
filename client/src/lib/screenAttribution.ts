/**
 * سياق شاشة غير سلطوي للطلبات الكاتبة. لا يرسل query أو hash كي لا تدخل فلاتر/أسرار
 * إلى سجل التدقيق؛ اسم الإجراء الخادمي يبقى الحقيقة الحاكمة لما نُفّذ.
 */
export function screenAttributionHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const path = window.location.pathname.trim();
  return path.startsWith("/") ? { "X-ERP-Screen-Path": path.slice(0, 255) } : {};
}
