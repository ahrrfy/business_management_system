/**
 * useDebouncedValue — قيمة مؤجَّلة لمدخلات البحث الحيّ.
 *
 * الكتابة السريعة على الكاشير كانت تطلق طلباً للخادم مع **كل ضغطة حرف**؛
 * التأجيل ~٢٠٠ms يرسل طلباً واحداً بعد استقرار الكتابة ⇒ أسرع استجابةً وأقل حملاً.
 * ملاحظة: القيمة الفارغة تُمرَّر فوراً (مسح الحقل بعد الإضافة يجب ألا ينتظر).
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === "" || value == null) {
      setDebounced(value);
      return;
    }
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
