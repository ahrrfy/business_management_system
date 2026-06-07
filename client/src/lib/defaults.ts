// افتراضيات ذكية تتذكّر آخر اختيار للمستخدم — تقليل الجهد (§٢.٢ أتمتة).
// تخزّن في localStorage تحت مفتاح موسوم، وتعيد آخر قيمة استعملها هذا المتصفّح.
// الاستعمال:
//   const [category, setCategory] = useSmartDefault("expense.category", "RENT");
//   // عند التغيير setCategory(v) يحفظ تلقائياً ⇒ الزيارة القادمة تبدأ من آخر فئة.
import { useCallback, useState } from "react";

const PREFIX = "alroya.default.";

/** يقرأ قيمة محفوظة (أو الافتراضي) ويعيد setter يحفظ تلقائياً. */
export function useSmartDefault<T extends string | number>(
  key: string,
  fallback: T
): [T, (v: T) => void] {
  const storageKey = PREFIX + key;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return fallback;
      return (typeof fallback === "number" ? (Number(raw) as T) : (raw as T));
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(storageKey, String(v));
      } catch {
        /* تجاهل (وضع خاص / ممتلئ) */
      }
    },
    [storageKey]
  );

  return [value, set];
}

/** قراءة قيمة افتراضية مرّة واحدة بلا حالة (لتهيئة النماذج). */
export function readDefault<T extends string | number>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return (typeof fallback === "number" ? (Number(raw) as T) : (raw as T));
  } catch {
    return fallback;
  }
}

/** حفظ قيمة افتراضية يدوياً (مثلاً بعد إرسال ناجح). */
export function writeDefault(key: string, value: string | number): void {
  try {
    localStorage.setItem(PREFIX + key, String(value));
  } catch {
    /* تجاهل */
  }
}
