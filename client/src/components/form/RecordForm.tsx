/**
 * RecordForm — الغلافُ الواحد لشاشات السجلّ بثلاثة أوضاع (القانون ق٤ من برنامج v2).
 *
 * **العلّة المقيسة:** كلُّ ثنائية `XNew.tsx`/`XEdit.tsx` تُعيد بناء الأشياء نفسها بيدٍ مختلفة:
 * `useSaveShortcuts` (يُنسى في نصف الشاشات)، `useUnsavedGuard` (بلقطةٍ مختلفة في كلّ شاشة)،
 * شريطُ حفظٍ مرتجل، ومعالجةُ نتيجةٍ تُظهر «نجاحاً أخضر» حتى حين أنشأ الخادم طلباً معلّقاً
 * (Codex FP-04). هذا الغلاف يربط الأربعة مرّةً واحدة:
 *   • `mode`: `create` ⇒ `edit` **بالشاشة نفسها حرفياً** — الحقول (children) واحدة، والغلاف يختلف
 *     في العنوان الافتراضيّ للزرّ لا أكثر؛ و`view` يُصيّر الحقول معطَّلة بلا شريط حفظ.
 *   • `Ctrl+S` عبر `SaveBar` (مستمعٌ واحد للشاشة)، و`Esc` ⇒ `onCancel` إن مُرِّر.
 *   • `useUnsavedGuard(isDirty)` — يعترض التبويب/الرابط/الرجوع/`navigate()` (#979).
 *   • **النتيجةُ المُهيكَلة** `{ status: SAVED | REQUESTED | CONFLICT | FAILED, message }`
 *     تُشتقّ من مآل `onSave` وتُعرض بجوار الزرّ — لا «نجاح» بعد طلبٍ معلّق.
 *
 * ⚠️ **لا `<form onSubmit>`** عمداً: ماسحُ الباركود (HID) يرسل Enter بعد كلّ مسح، و`<form>` كان
 * سيحفظ المنتج مع كلّ باركود. الحفظُ زرٌّ صريح أو `Ctrl+S`.
 *
 * ⚠️ **الأثر الجانبيّ للنجاح شأنُ المستدعي**: `onSave` يُرجع نتيجةَ الخادم (أو يرمي)، والغلاف
 * يُصنّفها ويعرضها. الإبطالُ/التنقّل بعد الحفظ يكتبه المستدعي داخل `onSave` أو في `onOutcome`.
 *
 * الاستعمال:
 *   ```tsx
 *   <RecordForm mode="edit" isDirty={isDirty} blockedBy={validate()} onSave={() => update.mutateAsync(payload)}>
 *     <ProductFormFields model={model} onChange={patch} />
 *   </RecordForm>
 *   ```
 */
import * as React from "react";

import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { cn } from "@/lib/utils";
import { ACTION_LABELS } from "@shared/actionLabels";
import { SaveBar } from "./SaveBar";
import { deriveSaveOutcome, type SaveOutcome } from "./saveOutcome";

export type RecordFormMode = "create" | "edit" | "view";

export type RecordFormProps = {
  mode: RecordFormMode;
  /** تعديلٌ غير محفوظ؟ — يقيسه المستدعي بلقطةٍ مرجعية (baseline) لا بعلَمٍ يدويّ. */
  isDirty: boolean;
  /**
   * الحفظ: يُرجع نتيجة الخادم أو يرمي. الغلاف يُصنّف المآل إلى `SaveOutcome`.
   * ⛔ لا يُستدعى وهو محجوب (`blockedBy`/`disabledReason`) — الشريط يعرض السبب بدل الاستدعاء.
   */
  onSave: () => Promise<unknown> | unknown;
  /** حفظٌ ثمّ نموذجٌ فارغ (وضع الإنشاء المتسلسل). */
  onSaveAndNew?: () => Promise<unknown> | unknown;
  /** حفظٌ ثمّ خروج. */
  onSaveAndClose?: () => Promise<unknown> | unknown;
  /** `Esc` وزرّ الإلغاء — يمرّ بحارس فقد البيانات إن كان المستدعي يستدعي `confirm()` فيه. */
  onCancel?: () => void;
  isPending?: boolean;
  /** شروطُ النموذج التي لم تتحقّق — تُعرض نصّاً بجوار الزرّ المعطَّل. */
  blockedBy?: string[];
  /** سببُ منعٍ يملكه الخادم/السجلّ (مقفول بطلبٍ معلّق، صلاحية…) — يُعرض ويُعطّل الحفظ. */
  disabledReason?: string;
  saveLabel?: string;
  /** عبارةُ النجاح (مثل «تم حفظ المنتج»). */
  savedMessage?: string;
  /** نتيجةٌ خارجية (مثل نتيجة استعادةٍ من لوحة السجلّ) تحلّ محلّ الداخلية حين تُمرَّر. */
  outcome?: SaveOutcome | null;
  /** يُستدعى بكلّ نتيجةٍ مُصنَّفة — للإبطال/التنقّل/التوست عند المستدعي. */
  onOutcome?: (outcome: SaveOutcome) => void;
  /** نصٌّ صغير في شريط الحفظ (ملخّص ما سيُحفظ). */
  barHint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

export function RecordForm({
  mode,
  isDirty,
  onSave,
  onSaveAndNew,
  onSaveAndClose,
  onCancel,
  isPending,
  blockedBy,
  disabledReason,
  saveLabel,
  savedMessage,
  outcome: outcomeProp,
  onOutcome,
  barHint,
  children,
  className,
}: RecordFormProps) {
  const editable = mode !== "view";
  useUnsavedGuard(editable && isDirty);

  const [outcome, setOutcome] = React.useState<SaveOutcome | null>(null);
  /*
   * نتيجةُ «تم الحفظ» تُخفى حين يعود النموذج متّسخاً: بقاؤها فوق تعديلٍ جديد يوهم أنّ الجديد
   * محفوظ. أمّا الرفض/التعارض/الطلب المعلّق فتبقى حتى المحاولة التالية — سببُ الفشل لا يُخفى بالكتابة.
   */
  React.useEffect(() => {
    if (isDirty && outcome?.status === "SAVED") setOutcome(null);
  }, [isDirty, outcome]);

  const classify = React.useCallback(
    async (handler: () => Promise<unknown> | unknown): Promise<SaveOutcome> => {
      let next: SaveOutcome;
      try {
        const result = await handler();
        next = deriveSaveOutcome({ result, savedMessage });
      } catch (error) {
        next = deriveSaveOutcome({ error });
      }
      setOutcome(next);
      onOutcome?.(next);
      return next;
    },
    [savedMessage, onOutcome],
  );

  const shown = outcomeProp !== undefined ? outcomeProp : outcome;

  return (
    <div data-slot="record-form" data-mode={mode} className={cn("space-y-4", className)}>
      {editable ? (
        children
      ) : (
        // `fieldset disabled` يُعطّل كلّ عنصر تحكّمٍ متداخل أصلاً (بما فيها أزرار Radix) بلا لمس كلّ حقل.
        <fieldset disabled className="m-0 min-w-0 space-y-4 border-0 p-0">
          {children}
        </fieldset>
      )}
      {editable && (
        <SaveBar
          onSave={() => classify(onSave)}
          onSaveAndNew={onSaveAndNew ? () => classify(onSaveAndNew) : undefined}
          onSaveAndClose={onSaveAndClose ? () => classify(onSaveAndClose) : undefined}
          onCancel={onCancel}
          isPending={isPending}
          blockedBy={blockedBy}
          disabledReason={disabledReason}
          saveLabel={saveLabel ?? (mode === "edit" ? ACTION_LABELS.saveChanges : ACTION_LABELS.save)}
          outcome={shown}
          hint={barHint}
        />
      )}
    </div>
  );
}
