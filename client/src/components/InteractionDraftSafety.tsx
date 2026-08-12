import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  beginInteractionScope,
  discardInteractionDraft,
  hasRecoverableInteractionDraft,
  noteInteraction,
  restoreInteractionDraft,
} from "@/lib/interactionDraft";

/**
 * يراقب الإدخالات العامة ويعرض استعادة اختيارية للمسودة بعد عودة التطبيق.
 * الاستعادة لا تتم آلياً حتى لا نعيد بيانات قديمة إلى عملية جديدة بدأها الموظف.
 */
export function InteractionDraftSafety() {
  const [location] = useLocation();
  const promptedPath = useRef<string | null>(null);

  useEffect(() => {
    const onInput = (event: Event) => {
      if (event.target instanceof Element) noteInteraction();
    };
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onInput, true);
    };
  }, []);

  useEffect(() => {
    const path = location;
    beginInteractionScope(path);
    if (promptedPath.current === path || !hasRecoverableInteractionDraft()) return;
    promptedPath.current = path;
    const id = toast("توجد إدخالات غير محفوظة من الجلسة السابقة", {
      duration: Infinity,
      action: {
        label: "استعادة",
        onClick: () => {
          // ننتظر اكتمال تركيب الصفحة الحالية؛ صفحات React المضبوطة تحتاج أحداث input.
          window.setTimeout(() => {
            if (restoreInteractionDraft()) toast.success("تمت استعادة الإدخالات غير المحفوظة");
            else toast.error("تعذّرت مطابقة المسودة مع النموذج الحالي");
          }, 0);
        },
      },
      cancel: { label: "تجاهل", onClick: discardInteractionDraft },
    });
    return () => { toast.dismiss(id); };
  }, [location]);

  return null;
}
