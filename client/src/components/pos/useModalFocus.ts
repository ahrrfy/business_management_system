// فخّ التركيز الموحّد لنوافذ الكاشير اليدوية (position:fixed).
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import { useEffect, useRef } from "react";

// فخّ تركيز موحّد للنوافذ اليدوية (position:fixed): يُركّز أوّل عنصر عند الفتح، يحبس Tab داخلها،
// ويعيد التركيز للعنصر السابق عند الإغلاق (WCAG 2.4.3 focus-trap). النوافذ تُركَّب فقط وهي مفتوحة.
export function useModalFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const prev = document.activeElement as HTMLElement | null;
    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const list = () => Array.from(node.querySelectorAll<HTMLElement>(SEL)).filter((el) => el.offsetParent !== null);
    list()[0]?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const items = list();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    node.addEventListener("keydown", onKey);
    return () => { node.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return ref;
}
