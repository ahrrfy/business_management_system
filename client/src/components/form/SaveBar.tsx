/**
 * SaveBar — شريط الحفظ الموحّد لشاشات الإنشاء/التعديل (القانون ق٤ من برنامج v2).
 *
 * **العلّة المقيسة:** كل شاشة `*New.tsx`/`*Edit.tsx` تخترع شريط حفظها بيدها:
 *   ```tsx
 *   <div className="sticky bottom-0 …">
 *     <Button onClick={submit} disabled={create.isPending} title="Ctrl+S">
 *       {create.isPending ? ACTION_LABELS.saving : "حفظ العميل"}
 *     </Button>
 *   ```
 * فتختلف الأزرار (بعضها «حفظ» وبعضها «حفظ العميل»)، ويختلف نصّ الانتظار، ويُنسى `Ctrl+S`
 * في نصف الشاشات، **وتضيع أسبابُ التعطيل**: `disabled={a || b || c || d}` يُطفئ الزرّ بأربعة
 * شروطٍ صامتة لا يعرف الموظّف أيُّها فشل — فيقف أمام زرٍّ ميّت بلا طريقٍ إلى الأمام.
 *
 * ⭐ **جوهر قيمة المكوّن: الزرُّ المعطَّل يقول لماذا.** حين يكون `blockedBy` غيرَ فارغ يُعرَض
 * كلّ شرطٍ لم يتحقّق **نصّاً ظاهراً فوق الأزرار** — لا في `title`/tooltip وحده:
 *   • الزرّ `disabled` أصلاً **لا يُطلق أحداث المرور** في المتصفّحات، فالـtooltip عليه لا يظهر.
 *   • ومستخدمُ اللمس (الكاشير على تابلت) بلا مؤشّرٍ يمرّ به أصلاً — يرى زرّاً ميّتاً وحسب.
 * فالعرض الظاهر هو المسار الوحيد الذي يصل إلى كل المستخدمين، وما دونه إخفاءٌ للسبب.
 *
 * ما يُعاد استعماله (لا يُكتَب جديداً):
 *  - `useSaveShortcuts` — `Ctrl/⌘+S` مع حراسة الطبقات المتراكبة (لا مستمع `keydown` جديد).
 *  - `KEYBOARD_SHORTCUTS` + `formatShortcut` — نصّ الاختصار مشتقٌّ من القاموس المعتمَد.
 *  - `ACTION_LABELS` — نصوص الانتظار/الأفعال (حارس `check:loading-strings`).
 *  - `SubmitButton` — نمط `isPending` + `Loader2` + `aria-busy` + منع النقر المزدوج.
 *  - `Kbd` — عرض الاختصار بهيئة النظام.
 *
 * الاستعمال:
 *   ```tsx
 *   <SaveBar
 *     onSave={submit}
 *     onSaveAndNew={saveThenReset}
 *     isPending={create.isPending}
 *     blockedBy={[
 *       ...(customerId ? [] : ["اختر العميل"]),
 *       ...(lines.length ? [] : ["أضف صنفاً واحداً على الأقل"]),
 *     ]}
 *     saveLabel="حفظ العميل"
 *   />
 *   ```
 *
 * ⚠️ **مكوّنٌ واحد لكل شاشة:** `Ctrl+S` عالميّ على النافذة، فشريطان مُصيَّران معاً يحفظان مرّتين.
 */
import * as React from "react";
import { AlertTriangle, CheckCheck, Lock, Plus, Save, X } from "lucide-react";

import { Kbd } from "@/components/ui/kbd";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useSaveShortcuts } from "@/hooks/useSaveShortcuts";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import { KEYBOARD_SHORTCUTS, formatShortcut } from "@shared/keyboardShortcuts";
import { SaveOutcomeNotice } from "./SaveOutcomeNotice";
import type { SaveOutcome } from "./saveOutcome";

/** «Ctrl+S» — يُشتقّ من قاموس الاختصارات لا يُكتب نصّاً ثابتاً (يتغيّر معه إن تغيّر). */
const SAVE_SHORTCUT_HINT = formatShortcut(KEYBOARD_SHORTCUTS.saveForm);

export type SaveBarProps = {
  /** الحفظ الرئيسيّ. قد يكون متزامناً أو `Promise` — الشريط يرصد انشغاله تلقائياً. */
  onSave: () => void | Promise<unknown>;
  /** حفظٌ ثمّ تهيئة نموذجٍ فارغ (الإدخال المتسلسل). يُخفى الزرّ إن لم يُمرَّر. */
  onSaveAndNew?: () => void | Promise<unknown>;
  /** حفظٌ ثمّ خروجٌ من الشاشة. يُخفى الزرّ إن لم يُمرَّر. */
  onSaveAndClose?: () => void | Promise<unknown>;
  /** انشغالٌ يملكه المستدعي (`mutation.isPending`). يُدمج مع انشغال الشريط الداخليّ. */
  isPending?: boolean;
  /** شروطٌ تمنع الحفظ — كلٌّ بنصّه. الزرُّ يُعطَّل **ويقول أيُّها فشل**. */
  blockedBy?: string[];
  /**
   * سببُ منعٍ واحد يملكه **الخادم/السجلّ** لا النموذج (مقفولٌ بطلبٍ معلّق، صلاحيةٌ ناقصة…) — يُعطّل
   * الحفظ ويُعرض بنصّه تحت رأس «الحفظ متوقّف». يختلف عن `blockedBy` (شروطُ إدخالٍ يصلحها المستخدم).
   */
  disabledReason?: string | null;
  /** `Esc` ⇒ إلغاء (اختياريّ) — بحراسة الطبقات المتراكبة في `useSaveShortcuts`. */
  onCancel?: () => void;
  /**
   * نتيجةُ آخر حفظٍ **مُهيكَلة** (م٦ ق٤، Codex FP-04): SAVED/REQUESTED/CONFLICT/FAILED تُعرض بجوار الأزرار —
   * فلا «نجاح أخضر» بعد إنشاء طلبٍ معلّق. يُشتقّها `RecordForm` من مآل `onSave`.
   */
  outcome?: SaveOutcome | null;
  /** نصٌّ صغير في الشريط (ملخّص ما سيُحفظ) — يُخفى على الشاشات الضيّقة. */
  hint?: React.ReactNode;
  /** نصّ الزرّ الرئيسيّ. الافتراضي «حفظ» من `ACTION_LABELS`. */
  saveLabel?: string;
  className?: string;
};

type BarAction = "save" | "saveAndNew" | "saveAndClose";

/** هل القيمة قابلةٌ للانتظار؟ — نرصد الانشغال للمعالِج غير المتزامن وحده. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

export function SaveBar({
  onSave,
  onSaveAndNew,
  onSaveAndClose,
  isPending = false,
  blockedBy,
  disabledReason,
  onCancel,
  outcome,
  hint,
  saveLabel,
  className,
}: SaveBarProps) {
  /*
   * تنظيفُ الأسباب: نُسقط الفارغ ونُزيل التكرار مع حفظ الترتيب. مصدرُ التكرار عمليّ لا نظريّ —
   * مُتحقِّقان مختلفان (النموذج والخادم) يصوغان الشرط نفسه، فتظهر «اختر العميل» مرّتين.
   * `disabledReason` يُدمج في القائمة نفسها (سببٌ واحد يقوله الخادم) كي يُعرض بالمسار الظاهر ذاته.
   */
  const reasons = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [...(blockedBy ?? []), disabledReason]) {
      const text = (raw ?? "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }, [blockedBy, disabledReason]);

  const blocked = reasons.length > 0;
  const lockedByRecord = !!(disabledReason ?? "").trim();

  /** أيُّ زرٍّ يعمل الآن — ليظهر الدوّار على الزرّ المضغوط لا على الثلاثة. */
  const [running, setRunning] = React.useState<BarAction | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pending = isPending || running !== null;
  const disabled = pending || blocked;

  const reasonsId = React.useId();
  const reasonsRef = React.useRef<HTMLDivElement | null>(null);
  /** وميضٌ قصير على لوحة الأسباب حين يُحاول المستخدم الحفظ وهو محجوب (Ctrl+S خاصّة). */
  const [nudged, setNudged] = React.useState(false);
  const nudgeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    },
    [],
  );

  /*
   * `Ctrl+S` وهو محجوب: لا نصمت. الزرُّ معطَّلٌ فالنقر مستحيل، لكنّ الاختصار يصل دائماً —
   * فلو تجاهلناه لظنّ الموظّف أنّ الاختصار معطوب. نُومض اللوحة ونمنحها التركيز فيقرأها
   * قارئ الشاشة، وهي أصلاً ظاهرةٌ للعين.
   */
  function nudgeBlocked() {
    setNudged(true);
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => {
      if (alive.current) setNudged(false);
    }, 2000);
    reasonsRef.current?.focus();
  }

  /*
   * تشغيل معالِج: نرصد الانشغال للـPromise وحده.
   * ⛔ لا نلتقط الرمي المتزامن — يمرّ إلى المستدعي كما هو، ولا حالةَ عالقة لأنّنا لم نُعلن
   *    الانشغال بعد. أمّا رفضُ الـPromise فنستهلكه **لتصفير الانشغال فقط** (وإلّا بقي الزرّ
   *    مجمَّداً على «جارٍ الحفظ…» بعد فشلٍ)، وإظهارُ الخطأ يبقى شأنَ الشاشة (`FormError`).
   */
  function run(action: BarAction, handler?: () => void | Promise<unknown>) {
    if (!handler) return;
    if (blocked) {
      nudgeBlocked();
      return;
    }
    if (pending) return;
    const result = handler();
    if (!isThenable(result)) return;
    setRunning(action);
    Promise.resolve(result).then(
      () => {
        if (alive.current) setRunning(null);
      },
      () => {
        if (alive.current) setRunning(null);
      },
    );
  }

  /*
   * ⚠️ لا نمرّر `enabled: !pending`: تعطيلُ الهوك يُلغي المستمع، فيفلت `Ctrl+S` إلى المتصفّح
   * ويفتح حوار «حفظ الصفحة» في منتصف حفظٍ جارٍ. نُبقي المستمع مثبَّتاً و`run` هو الحارس.
   */
  useSaveShortcuts({
    onSave: () => run("save", onSave),
    onCancel,
  });

  const savePending = running === "save" || (isPending && running === null);

  return (
    <div
      data-slot="save-bar"
      data-blocked={blocked || undefined}
      className={cn(
        // Codex #1010: `fixed` لا `sticky`. `app-shell` بـ`min-h-screen` يجعل **الجسمَ** هو المُمرَّر لا `main`،
        // فـ`sticky bottom-0` على آخر عنصرٍ لا يُسحَب إلى العرض في النماذج الطويلة (تحقّقٌ بصريّ) ⇒ لا أزرارَ
        // حفظٍ ولا أسبابُ منعٍ مرئيّة حتى التمرير للنهاية. `fixed` يُبقيه ظاهراً دائماً (استعادةُ الأشرطة الثابتة
        // السابقة)؛ `lg:start-64` يُخلي الشريطَ الجانبيّ (w-64) في RTL، والحاوياتُ تحجز `pb-28` أسفلها.
        "fixed inset-x-0 bottom-0 z-30 lg:start-64 flex flex-col gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6",
        className,
      )}
    >
      {blocked && (
        /*
         * `role="status"` + `aria-live="polite"` لا `alert`: اللوحة **دائمة** ما دام الشرط
         * قائماً وتتغيّر مع كل حرفٍ يكتبه المستخدم؛ فالإعلان الحادّ (`assertive`) يقاطعه
         * وهو يكتب. و`tabIndex={-1}` ليصحّ نقلُ التركيز إليها عند محاولة حفظٍ محجوبة.
         */
        <div
          ref={reasonsRef}
          id={reasonsId}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className={cn(
            "rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-2.5 text-xs text-[var(--sem-warn)] outline-none transition-shadow",
            nudged && "ring-2 ring-[var(--sem-warn)]",
          )}
        >
          <p className="flex items-center gap-1.5 font-bold">
            {lockedByRecord ? (
              <Lock aria-hidden className="size-4 shrink-0" />
            ) : (
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
            )}
            <span>{lockedByRecord ? "الحفظ متوقّف الآن" : "تعذّر الحفظ — شروطٌ لم تتحقّق بعد"}</span>
            <span className="ms-auto rounded-full border border-current px-1.5 py-px text-[10px] font-black tabular-nums">
              {reasons.length}
            </span>
          </p>
          <ul className="mt-1.5 space-y-1">
            {reasons.map((reason) => (
              <li key={reason} className="flex items-start gap-1.5 leading-relaxed">
                <X aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* نتيجةُ آخر حفظ — فوق الأزرار وبنفس شكلها في كلّ الشاشات (لا توستٌ يختفي قبل أن يُقرأ). */}
      <SaveOutcomeNotice outcome={outcome} />

      {hint != null && hint !== false && (
        <div className="hidden text-xs text-muted-foreground sm:block">{hint}</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* `type="button"`: الشريط يستدعي المعالِج مباشرةً؛ لو بقي `submit` داخل `<form onSubmit>`
            لانطلق المساران معاً ⇒ حفظٌ مزدوج. */}
        <SubmitButton
          type="button"
          pending={savePending}
          pendingText={ACTION_LABELS.saving}
          disabled={disabled}
          aria-describedby={blocked ? reasonsId : undefined}
          title={blocked ? undefined : SAVE_SHORTCUT_HINT}
          onClick={() => run("save", onSave)}
        >
          <Save aria-hidden className="size-4" />
          {saveLabel ?? ACTION_LABELS.save}
        </SubmitButton>

        {onSaveAndNew && (
          <SubmitButton
            type="button"
            variant="outline"
            pending={running === "saveAndNew"}
            pendingText={ACTION_LABELS.saving}
            disabled={disabled}
            aria-describedby={blocked ? reasonsId : undefined}
            onClick={() => run("saveAndNew", onSaveAndNew)}
          >
            <Plus aria-hidden className="size-4" />
            حفظ وجديد
          </SubmitButton>
        )}

        {onSaveAndClose && (
          <SubmitButton
            type="button"
            variant="outline"
            pending={running === "saveAndClose"}
            pendingText={ACTION_LABELS.saving}
            disabled={disabled}
            aria-describedby={blocked ? reasonsId : undefined}
            onClick={() => run("saveAndClose", onSaveAndClose)}
          >
            <CheckCheck aria-hidden className="size-4" />
            حفظ وإغلاق
          </SubmitButton>
        )}

        {/* تلميح الاختصار — يُخفى على الشاشات الضيّقة (الهاتف) حيث لا لوحة مفاتيح.
            نستعمل `sm:` لا `[@media(pointer:fine)]`: الثانية أدقّ دلالةً لكنّها بلا سابقةٍ في
            المستودع، وفشلُها في التصريف يُخفي التلميح **في كل مكان** بصمت. */}
        <span className="ms-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
          <Kbd>{SAVE_SHORTCUT_HINT}</Kbd>
          <span>{ACTION_LABELS.save}</span>
        </span>
      </div>
    </div>
  );
}
