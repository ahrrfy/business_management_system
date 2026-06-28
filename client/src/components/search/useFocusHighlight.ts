// useFocusHighlight — الميل الأخير للبحث الشامل (Ctrl+K) إلى صفحات القوائم (داخل hubs).
//
// globalSearch يوجّه بعض الكيانات إلى قائمةٍ بمعاملات `?focus=<id>` (ومعها `?q=<term>`
// للقوائم المُصفّحة خادمياً كي يُحمَّل الصفّ أوّلاً): منتجات/عملاء/مصروفات/مشتريات.
// هذا الـhook يقرأ المعاملات **تفاعلياً** عبر useSearch (يستجيب حتى لو بقيت الصفحة مركّبة
// داخل نفس الـhub)، يُبرز الصفّ المطابق ويمرّره لوسط الشاشة، ثمّ يخفي الإبراز بعد مهلة.
import { useCallback, useEffect, useState } from "react";
import { useSearch } from "wouter";

/** صنف إبراز الصفّ المطابق (حلقة داخلية + خلفية خفيفة) — يخفت بعد المهلة أدناه. */
export const FOCUS_ROW_CLASS = "ring-2 ring-inset ring-primary/70 bg-primary/5";

/** مدّة بقاء الإبراز قبل أن يخفت (مللي ثانية). */
const HIGHLIGHT_MS = 3200;

export function useFocusHighlight() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const raw = params.get("focus");
  const focusId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  /** نصّ بحث ممرَّر من البحث الشامل لتحميل الصفّ في القوائم الخادمية (قد يكون فارغاً). */
  const seedQuery = params.get("q") ?? "";

  const [active, setActive] = useState<number | null>(focusId);
  useEffect(() => {
    setActive(focusId);
    if (focusId == null) return;
    const t = setTimeout(() => setActive(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [focusId]);

  // ref callback: يُمرّر الصفّ المطابق إلى وسط الشاشة عند تركيبه.
  const focusRef = useCallback((el: HTMLElement | null) => {
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  /** خصائص الصفّ المطابق: { ref, className }. ادمج className مع أصناف الصفّ الأصلية. */
  const rowProps = useCallback(
    (id: number | string | null | undefined) => {
      const isFocused = active != null && Number(id) === active;
      return {
        ref: isFocused ? focusRef : undefined,
        className: isFocused ? FOCUS_ROW_CLASS : "",
      };
    },
    [active, focusRef],
  );

  return { focusId, seedQuery, focusRef, rowProps };
}
