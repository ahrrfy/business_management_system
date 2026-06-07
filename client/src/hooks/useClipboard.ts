// نسخ للحافظة مع تنبيه «تم النسخ» — لتفادي النقل اليدوي الخاطئ للأرقام/الباركود.
// يدعم بديل execCommand لبيئة HTTP/غير الآمنة (شبكة المتجر المحلّية حيث لا تتوفّر navigator.clipboard).
//   const { copied, copy } = useClipboard();
//   <button onClick={() => copy(invoice.number)} />
import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "@/lib/notify";

export type UseClipboardOptions = {
  /** مدّة حالة «تم النسخ» بالمللي ثانية (افتراضي ١٥٠٠). */
  timeout?: number;
  /** رسالة النجاح — مرّر null لكتم التنبيه (مفيد في الجداول الكثيفة). */
  successMessage?: string | null;
};

export type UseClipboardReturn = {
  copied: boolean;
  copy: (value: string | number | null | undefined) => Promise<boolean>;
};

export function useClipboard(options: UseClipboardOptions = {}): UseClipboardReturn {
  const { timeout = 1500, successMessage = "تم النسخ" } = options;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (value: string | number | null | undefined) => {
      const text = value == null ? "" : String(value);
      if (!text) return false; // لا ننسخ قيمة فارغة (لا ضجيج تنبيهات)

      let ok = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        } else {
          ok = legacyCopy(text);
        }
      } catch {
        // بعض المتصفّحات ترفض clipboard API خارج السياق الآمن ⇒ جرّب البديل.
        ok = legacyCopy(text);
      }

      if (ok) {
        setCopied(true);
        if (successMessage) notify.ok(successMessage);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), timeout);
      } else {
        notify.err(new Error("تعذّر النسخ — انسخ القيمة يدوياً."));
      }
      return ok;
    },
    [successMessage, timeout],
  );

  return { copied, copy };
}

/** بديل النسخ عبر textarea + execCommand لبيئة HTTP غير الآمنة. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
