import { useEffect, useRef } from "react";

/**
 * اختصارات النماذج الموحّدة — Ctrl/⌘+S ⇒ حفظ، Esc ⇒ إلغاء (اختياري).
 *
 * لماذا هوك مشترك: كان كل نموذج يكتب مستمع keydown خاصاً بمصفوفة اعتماديات ضخمة بكل حقوله
 * (نظير CustomerNew قبل هذا) — تكرار هشّ يسهل أن يُنسى في نموذجٍ جديد. هنا نُخزّن المعالِجات في
 * ref فيبقى المستمع مثبَّتاً مرّة واحدة ويستدعي أحدث نسخة دائماً بلا مصفوفة اعتماديات.
 *
 * حراسة الطبقات المتراكبة (Radix overlays): لا نُطلق الحفظ إن كان حوارٌ مشروط مفتوحاً (لئلا
 * يُرسَل النموذج الأمّ من داخل حوار تأكيد)، ولا نُطلق الإلغاء إن كان أيّ حوار/قائمة منسدلة
 * مفتوحاً (Esc يُغلقها أولاً). يُكتشَف ذلك من سمات Radix في DOM.
 *
 * ⚠️ قيود Esc: القوائم المنسدلة الأصلية (native <select>) لا تُكتشَف حالتُها، فمرّر `onCancel`
 * فقط للنماذج التي يُتوقَّع فيها Esc=إلغاء أصلاً. النماذج المكتظّة بـ<select> أصلية اكتفِ فيها
 * بـ`onSave` (Ctrl+S) لتجنّب تعارض Esc مع إغلاق القائمة.
 */
type SaveShortcutOpts = {
  onSave?: () => void;
  /** إن مُرِّر: Esc يستدعيه (مع حراسة الطبقات المتراكبة). */
  onCancel?: () => void;
  /** تعطيل مؤقّت (مثلاً أثناء حفظٍ جارٍ لمنع استدعاء مزدوج). افتراضياً مُفعَّل. */
  enabled?: boolean;
};

/** هل حوارٌ مشروط (modal) مفتوح؟ — نمنع Ctrl+S من إرسال النموذج الأمّ من داخله. */
function modalOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    !!document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    )
  );
}

/** هل أيّ طبقة متراكبة (حوار/قائمة/منبثق Radix) مفتوحة؟ — Esc يُغلقها أولاً لا يُلغي النموذج. */
function anyOverlayOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    !!document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-radix-popper-content-wrapper]',
    )
  );
}

export function useSaveShortcuts({ onSave, onCancel, enabled = true }: SaveShortcutOpts): void {
  const ref = useRef<{ onSave?: () => void; onCancel?: () => void }>({ onSave, onCancel });
  ref.current = { onSave, onCancel };

  useEffect(() => {
    if (!enabled) return;
    function handler(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (modalOpen() || !ref.current.onSave) return;
        e.preventDefault();
        ref.current.onSave();
      } else if (e.key === "Escape" && ref.current.onCancel) {
        if (anyOverlayOpen()) return;
        ref.current.onCancel();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}
