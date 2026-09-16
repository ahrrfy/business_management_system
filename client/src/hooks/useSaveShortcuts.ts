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

type Handlers = { onSave?: () => void; onCancel?: () => void; enabled: boolean };
type Entry = { ref: { current: Handlers } };

/**
 * ⭐ سجلٌّ مركزيّ واحد — **الأعمقُ تركيباً يفوز** (م٦، أمسكته الجولة البصريّة):
 * شاشةُ المنتج تربط Ctrl+S لمحرّر المتغيّرات، وتُصيّر داخلها نموذجَ «السلعة البسيطة» بشريط حفظه
 * (`RecordForm`/`SaveBar`) الذي يربط Ctrl+S أيضاً ⇒ ضغطةٌ واحدة أطلقت **حفظَين متزامنَين** على المنتج
 * نفسه (طلبان في دفعة tRPC واحدة، والثاني سقط على UNIQUE النسخ). مستمعٌ مستقلّ لكلّ مستهلكٍ يجعل
 * كلَّ تركيبٍ متداخل حفظاً مزدوجاً بالضرورة.
 * القاعدة: عند Ctrl+S/Esc يُستدعى **آخرُ معالِجٍ مثبَّتٍ مُفعَّل** (الابنُ الأحدث تركيباً) وحده، وحين يُفكَّك
 * يعود الدورُ لمن قبله. المدخل يُسجَّل عند التركيب ويحتفظ بموضعه ولو تبدّل `enabled` (لا يقفز إلى القمّة).
 */
const stack: Entry[] = [];
let listening = false;

/** المعالِجُ الفعّال: آخرُ مدخلٍ مُفعَّل في السجلّ — دالّةٌ نقيّة تُختبر بلا DOM. */
export function activeHandlers(entries: ReadonlyArray<Entry>): Handlers | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].ref.current.enabled) return entries[i].ref.current;
  }
  return null;
}

function keydownHandler(e: KeyboardEvent) {
  const active = activeHandlers(stack);
  if (!active) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    if (modalOpen() || !active.onSave) return;
    e.preventDefault();
    active.onSave();
  } else if (e.key === "Escape" && active.onCancel) {
    if (anyOverlayOpen()) return;
    active.onCancel();
  }
}

function attachListener() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("keydown", keydownHandler);
  listening = true;
}
function detachListenerIfIdle() {
  if (!listening || stack.length > 0 || typeof window === "undefined") return;
  window.removeEventListener("keydown", keydownHandler);
  listening = false;
}

export function useSaveShortcuts({ onSave, onCancel, enabled = true }: SaveShortcutOpts): void {
  const ref = useRef<Handlers>({ onSave, onCancel, enabled });
  ref.current = { onSave, onCancel, enabled };

  useEffect(() => {
    const entry: Entry = { ref };
    stack.push(entry);
    attachListener();
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      detachListenerIfIdle();
    };
  }, []);
}

/** @internal — للاختبار فقط. */
export const __TEST_ONLY__ = {
  activeHandlers,
  stackSize: () => stack.length,
};
