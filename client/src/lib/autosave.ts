// حفظ تلقائي لمسوّدات النماذج الطويلة — لا يضيع إدخال عند تحديث الصفحة (§٢.٢/٢.٤).
// يخزّن في localStorage بـdebounce، ويعيد الاسترجاع + الحالة (متى حُفظت آخر مرّة).
// الاستعمال:
//   const draft = useAutosave("purchase-new", values);   // values كائن قابل للتسلسل
//   // عند التحميل: const initial = draft.restore() ?? EMPTY;
//   // عند الإرسال الناجح: draft.clear();
//   // عرض الحالة: draft.savedAt && <span>✓ مسوّدة محفوظة</span>
import { useEffect, useRef, useState } from "react";

const PREFIX = "alroya.draft.";
const DEBOUNCE_MS = 2000;
const activeFlushers = new Set<() => boolean>();

/** يفرّغ كل مسودات النماذج المركّبة قبل تحديث اختاره الموظف. */
export function flushAutosaves(): { attempted: number; ok: boolean } {
  let ok = true;
  for (const flush of Array.from(activeFlushers)) ok = flush() && ok;
  return { attempted: activeFlushers.size, ok };
}

type Draft<T> = {
  /** يعيد آخر مسوّدة محفوظة أو null. استدعِه مرّة عند تهيئة النموذج. */
  restore: () => T | null;
  /** يمسح المسوّدة (بعد إرسال ناجح). */
  clear: () => void;
  /** يكتب القيمة الحالية فوراً؛ يُستدعى قبل تحديث اختاره المستخدم. */
  flush: () => boolean;
  /** طابع زمني لآخر حفظ (للعرض «محفوظة قبل ٣ث»)، أو null. */
  savedAt: number | null;
};

export function useAutosave<T>(key: string, value: T, enabled = true): Draft<T> {
  const storageKey = PREFIX + key;
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);
  const valueRef = useRef(value);
  valueRef.current = value;
  const flushRef = useRef<() => boolean>(() => false);

  const write = (next: T): boolean => {
    if (!enabled) return false;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ v: next, t: Date.now() }));
      setSavedAt(Date.now());
      return true;
    } catch {
      return false;
    }
  };
  flushRef.current = () => {
    if (timer.current) clearTimeout(timer.current);
    return write(valueRef.current);
  };

  useEffect(() => {
    if (!enabled) return;
    const flush = () => flushRef.current();
    activeFlushers.add(flush);
    return () => { activeFlushers.delete(flush); };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    // لا تحفظ على أوّل تمرير (قيمة التهيئة) — فقط على تغيّر فعلي.
    if (first.current) {
      first.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      write(value);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [storageKey, value, enabled]);

  return {
    restore() {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { v: T; t: number };
        return parsed.v ?? null;
      } catch {
        return null;
      }
    },
    clear() {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* تجاهل */
      }
      setSavedAt(null);
    },
    flush() {
      return flushRef.current();
    },
    savedAt,
  };
}
