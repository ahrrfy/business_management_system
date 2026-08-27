/**
 * حفظ فلاتر الشاشة في querystring — الفلتر يعيش مع فتح التفاصيل والرجوع، ويُشارَك رابطاً.
 * (نمط عرضي كشفه تدقيق الشاشات ٣/٨/٢٦: >٣٠ شاشة تفقد فلاترها عند أي تنقّل.)
 *
 * الاستعمال:
 *   const [f, setF, resetF] = useUrlFilters({ q: "", status: "", branch: "" });
 *   <Input value={f.q} onChange={(e) => setF({ q: e.target.value })} />
 *   <Button onClick={resetF}>مسح الفلاتر</Button>
 *
 * كل القيم نصوص. القيمة المساوية للافتراضي تُحذف من الـURL (روابط نظيفة).
 * الكتابة بـreplaceState — لا تُنشئ إدخالات تاريخ متصفح جديدة لكل حرف بحث.
 * يعمل مع wouter لأن كليهما فوق history API نفسه (المسار لا يُمسّ، فقط الـsearch).
 */
import { useCallback, useMemo, useRef, useState } from "react";

export function useUrlFilters<T extends Record<string, string>>(
  defaults: T,
): [T, (patch: Partial<T>) => void, () => void] {
  const defaultsRef = useRef(defaults);

  const initial = useMemo(() => {
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    const out = { ...defaultsRef.current };
    for (const key of Object.keys(out) as (keyof T)[]) {
      const v = params.get(String(key));
      if (v != null) out[key] = v as T[keyof T];
    }
    return out;
  }, []);

  const [state, setState] = useState<T>(initial);
  // مرجعٌ فوريّ يمنع وضع `history.replaceState` داخل دالة تحديث React. هذا مهم عند مسح
  // الباركود: تحديث الرابط يوقظ مستمعي التنقّل فوراً، ولو حدث داخل updater ظهر تحذير
  // «Cannot update PageTabs while rendering Inventory» وقد تتقطّع واجهة المسح.
  const stateRef = useRef<T>(initial);

  const write = useCallback((next: T) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    for (const [key, def] of Object.entries(defaultsRef.current)) {
      const v = next[key as keyof T];
      if (v === def || v === "") params.delete(key);
      else params.set(key, String(v));
    }
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  const setFilters = useCallback(
    (patch: Partial<T>) => {
      // المرجع يحفظ أيضاً سلامة تحديثين متزامنين في الحدث نفسه؛ كل تحديث يبني على أحدث
      // قيمة فوراً، بينما تحديث React نفسه قد يبقى مجمّعاً حتى نهاية الحدث.
      const next = { ...stateRef.current, ...patch };
      stateRef.current = next;
      setState(next);
      write(next);
    },
    [write],
  );

  const reset = useCallback(() => {
    const next = defaultsRef.current;
    stateRef.current = next;
    setState(next);
    write(next);
  }, [write]);

  return [state, setFilters, reset];
}
