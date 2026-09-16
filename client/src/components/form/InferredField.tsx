/**
 * InferredField — يعرض قيمةً **يعرفها الخادم أصلاً** ولا يسألها من المستخدم.
 *
 * القاعدةُ التي يُلبّيها: ٢٣٨ عقدَ راوترٍ يطلب `branchId` بينما الخادم يعرفه من `ctx.user.branchId`
 * ويحقن `scopedBranchId` بنفسه. الحقلُ الذي لا معنى له إلّا أن يُرفَض هو حقلٌ يُغري الشاشةَ
 * باختراع قيمة (`useState<number>(1)`؛ `?? 1` هو النمط الذي يحرسه `check:branch`). هذا المكوّن
 * يحلّ ذلك دون تنازلٍ عن الإنفاذ:
 *   ١) القيمةُ تُقرأ من `useSessionBranchInference` (لا من الشاشة).
 *   ٢) يُبلّغ الأبَ بها عبر `onChange` ⇒ حالةُ النموذجُ تبقى واحدة، والحفظُ يُرسلها كما هي.
 *   ٣) للمالك/الأدمن **زرُّ «تغيير»** يفتح `AppSelect` بقائمة فروعٍ خادميّة — عبورُ الفروع
 *      حقٌّ مشروع للأدمن (يُرسله للخادم فيقبله لأنّ `canCrossBranches=true` مُعادةُ اشتقاقٍ هناك).
 *   ٤) لغيرِ عابر الفروع، القيمةُ **قراءةٌ فقط ولا تُخفَى**: الموظّفُ يرى الفرع الذي سيُنسَب
 *      إليه العملُ فيدرك المسؤولية، ولا نُخفيه فينتفَي التدقيق البصريّ.
 *   ٥) حين يتعذّر الاستنتاج (خطأ جلسة/غياب إسناد)، يُعرض **مخرج عمليّ** بصيغة «ماذا حدث ·
 *      لماذا · ماذا تفعل» (عقدُ `shared/errors.ts`) لا حقلٌ فارغٌ صامتٌ يوجّه المستخدمَ للتخمين.
 *
 * ⚠️ **ليس إنفاذاً**: الشاشةُ قد تُرسل `branchId` مختلفاً بأدواتٍ خارجية؛ الإنفاذُ النهائيّ في
 *   `branchScopedProcedure` خادمياً (§٢). دور هذا المكوّن هو **إزالةُ الإغراء**، لا سدُّ الحقن.
 *
 * ⛔ **لا يقبل قيمةً افتراضية**: تمريرُ `defaultBranchId={1}` كان النمطَ الذي يحرسه
 *   `check:branch` — والمكوّن يبني قيمتَه من `useSessionBranchInference` وحدها.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Building2, Pencil, RefreshCw, Sparkles, X } from "lucide-react";
import { AppSelect } from "@/components/ui/AppSelect";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  useSessionBranchInference,
  type SessionBranchInference,
} from "@/hooks/useSessionContext";

interface InferredBranchFieldProps {
  /**
   * تسمية الحقل. تُلصَق بـ`<Label>` وتربطه بالحقل عبر `htmlFor` — قارئُ الشاشة يقرأ
   * «الفرع، فرعك المُسنَد، MAIN» بدل «combobox، MAIN» وحدها.
   */
  label: string;
  /**
   * القيمة الحاليّة كما تحتفظ بها الشاشة. `null` = «لم يُخترَ بعد» (والمكوّن يستنتج).
   * الأبُ يحتفظ بها في `useState` عاديّة كأيّ حقل — لا سياق ولا reducer إجباريّ.
   */
  value: number | null;
  /**
   * ⛔ **يُستدعى بالقيمة المستنتَجة تلقائياً** أوّل ما يصل الاستنتاج (لا `useEffect` في الأب).
   * الأبُ يبني حمولةَ الحفظ من نفس القيمة التي عرضها المكوّنُ حرفياً — فلا انزلاق.
   */
  onChange: (branchId: number | null) => void;
  /** حالةُ الحفظ الجارية — يعطّل التغيير أثناء `mutation.isPending`. */
  disabled?: boolean;
  /**
   * معرّفُ الحقل — يُربَط بالتسمية عبر `htmlFor` ولوصف قارئ الشاشة. الافتراضيّ ثابتٌ لأنّ
   * كثيراً من الشاشات تستعمل حقلَ فرعٍ واحد؛ عند تعدّده مرّر معرّفاتٍ مختلفة.
   */
  id?: string;
  /** class إضافيّ للحاوية (نادر، للتنسيق الشبكيّ). */
  className?: string;
}

/**
 * حقلُ استنتاج **الفرع النشط**. مكوّنٌ متخصّصٌ لأنّ `branchId` هو الحقل ذو الحرّاس (`?? 1`
 * محظور) والذي يمثّل ٦٩ إجراءً من الـ٢٣٨ التي يعرفها الخادم أصلاً. الحقولُ الأخرى المستنتَجة
 * (يوم تشغيليّ، `paymentMethod` الافتراضيّ) لها مكوّناتٌ نظيرة يمكن اشتقاقُها من `InferredField`
 * العامّ إن دعت الحاجة — انظر «المرحلةُ التالية» في تقرير الـPR.
 */
export function InferredBranchField({
  label,
  value: branchId,
  onChange,
  disabled,
  id = "inferred-branch",
  className,
}: InferredBranchFieldProps): React.ReactElement {
  const inference = useSessionBranchInference();
  const [pickerOpen, setPickerOpen] = useState(false);

  // ← أوّل ما يصل الاستنتاجُ وحالةُ الأب لم تُحسم، نسنِد القيمةَ صراحةً. لا نلمسها بعد ذلك
  //   حتى لو تغيّر الاستنتاج (الأبُ صاحبُ الحالة، ومسح قيمتِه بلا سببٍ يُفقده تعديلاً يدوياً).
  useEffect(() => {
    if (
      branchId == null &&
      inference.status === "resolved" &&
      inference.branchId != null
    ) {
      onChange(inference.branchId);
    }
    // لا نضيف `branchId` إلى deps: هذا مسارٌ ذو اتّجاهٍ واحد (استنتاج → أب)، وإدراجُها يُنتج
    //   حلقةَ إعادةِ تعيينٍ حين يمسح المستخدمُ القيمةَ عمداً.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inference.status, inference.branchId]);

  // زرُّ التغيير مسموحٌ فقط للأدمن/المالك ومع غير الـdisabled. حين لا فرعَ مُسنَد أصلاً
  // (`unassigned` = أدمن بلا فرع)، القائمةُ تُعرَض مباشرة بلا زرّ — فرضٌ لطيف على الاختيار.
  const canPick = inference.canOverride && !disabled;
  // القائمةُ تظهر أيضاً حين تخالف قيمةُ الأب الفرعَ المستنتَج (تبديلٌ من خارج المكوّن، كزرّ
  // «عكس الاتجاه» في التحويل): ما سيُرسَل يجب أن يُرى، لا أن يُغطّيه عرضُ الفرع المستنتَج.
  const deviates =
    inference.status === "resolved" && branchId != null && branchId !== inference.branchId;
  const showPicker = pickerOpen || deviates || inference.status === "unassigned";

  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id}>{label}</Label>
      <InferredFieldBody
        id={id}
        inference={inference}
        branchId={branchId}
        onChange={onChange}
        disabled={disabled}
        canPick={canPick}
        showPicker={showPicker}
        onOpenPicker={() => setPickerOpen(true)}
        onClosePicker={() => setPickerOpen(false)}
      />
    </div>
  );
}

/**
 * جسمُ الحقل بعد التسمية — مفصولٌ لتقليل حجم الدالّة الأمّ وحرصاً على تفكّرٍ خطّي في العرض.
 * سمّينا القيمةَ الداخليّةَ `branchId` (لا `value`) عمداً: حارسُ `check:form-parity` يتّبع
 * مكوّنات `@/components/form/**` تعدّياً ويستخرج أسماء الحقول من روابط `value={…}`، فتسميةُ
 * القيمة بـ`value` كانت تُنتج «حقلاً» اسمه `value` في كلّ شاشةٍ تستهلك هذا المكوّن — وهو حقلٌ
 * وهميّ يرفع الانحرافَ مع الأخت (Edit). البصمةُ الآن `branchId`، وهو حقلٌ موجودٌ في الأختين معاً.
 */
function InferredFieldBody({
  id,
  inference,
  branchId,
  onChange,
  disabled,
  canPick,
  showPicker,
  onOpenPicker,
  onClosePicker,
}: {
  id: string;
  inference: SessionBranchInference;
  branchId: number | null;
  onChange: (branchId: number | null) => void;
  disabled?: boolean;
  canPick: boolean;
  showPicker: boolean;
  onOpenPicker: () => void;
  onClosePicker: () => void;
}) {
  // hooks قبل أيّ `return` مبكر: قاعدة React (نفسُ الترتيب في كلّ عرض) — عرضُ الاسم مشتقّ
  // من الاستنتاج، ونحتاجه في الفرع «resolved» أدناه. حسابُه هنا رخيص وعامّ.
  const displayName = useMemo(() => {
    if (inference.branchName) return inference.branchName;
    if (inference.branchId != null) return `فرع #${inference.branchId}`;
    return "—";
  }, [inference.branchId, inference.branchName]);

  // ─── تحميل ───────────────────────────────────────────────────────────────
  if (inference.status === "loading") {
    return (
      <div
        id={id}
        role="status"
        aria-live="polite"
        className="flex h-9 items-center rounded-md border border-input bg-muted/30 px-3 text-sm text-muted-foreground"
      >
        {/* شارةُ تحميلٍ نصّية — لا سلسلةَ حالةٍ يدويّة (`check:loading-strings`). */}
        <span className="animate-pulse">جارٍ قراءة جلستك…</span>
      </div>
    );
  }

  // ─── خطأ ─────────────────────────────────────────────────────────────────
  if (inference.status === "error") {
    return (
      <div
        id={id}
        role="alert"
        className="flex items-start gap-2 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg-bg)] p-3 text-sm text-[var(--sem-neg)]"
      >
        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span className="flex-1">
          {inference.message ??
            "تعذّرت قراءةُ جلستك · انتهت الجلسة أو لم تُقبل · سجّل الدخول مجدّداً."}
        </span>
        {/* المخرجُ العمليّ الذي تذكره الرسالة يجب أن يكون زرّاً فعلياً لا وعداً. */}
        <button
          type="button"
          onClick={inference.retry}
          className="inline-flex shrink-0 items-center gap-1 text-xs underline-offset-2 hover:underline"
        >
          <RefreshCw aria-hidden className="size-3" />
          إعادة المحاولة
        </button>
      </div>
    );
  }

  // ─── قائمةُ الاختيار المفتوحة (تجاوز مشروع أو أدمن بلا فرع) ─────────────────
  if (showPicker) {
    // ⚠️ لا فرعَ افتراضيّ في القائمة: القيمةُ الفارغة تُبقي زرَّ الحفظ معطَّلاً في الأب،
    //   ولا يقع «الفرع ١» صامتاً من ترتيبٍ عرضيّ.
    return (
      <div className="space-y-1">
        <AppSelect
          id={id}
          value={branchId != null ? String(branchId) : ""}
          // غيرُ عابر الفروع يرى قيمةً مخالفةً (إن وُجدت) ولا يُبدّلها — الخادم سيرفضها أصلاً؛
          // مخرجُه «استعِد الفرعَ المسند» أدناه.
          disabled={disabled || !inference.canOverride}
          onValueChange={(next) => onChange(next ? Number(next) : null)}
          className="h-9"
        >
          <option value="">— اختر الفرعَ —</option>
          {inference.branches.map((b) => (
            <option key={b.id} value={String(b.id)}>
              {b.name}
            </option>
          ))}
        </AppSelect>
        {inference.status !== "unassigned" && (
          <button
            type="button"
            onClick={() => {
              onChange(inference.branchId);
              onClosePicker();
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <X aria-hidden className="size-3" />
            استعِد الفرعَ المُسنَد
          </button>
        )}
        {inference.status === "unassigned" && inference.message && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--sem-warn)]">
            <AlertCircle aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span>{inference.message}</span>
          </p>
        )}
      </div>
    );
  }

  // ─── العرضُ الاستنتاجيّ العاديّ (`resolved`) ─────────────────────────────
  return (
    <div className="space-y-1">
      <div
        id={id}
        className="flex h-9 items-center gap-2 rounded-md border border-input bg-muted/30 px-3 text-sm"
        // ⚠️ لا `disabled`/`aria-disabled` هنا: الحقلُ **يعرض** لا يُدخل — فتعطيلُه بصرياً يخدع.
        // القراءةُ العارضة تُعرَف بغياب الحدود الفعّالة والخلفيّة الرماديّة.
      >
        <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" title={displayName}>
          {displayName}
        </span>
        {canPick && (
          <button
            type="button"
            onClick={onOpenPicker}
            className="ms-auto inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
          >
            <Pencil aria-hidden className="size-3" />
            تغيير
          </button>
        )}
      </div>
      {/* مصدرُ القيمة في سطرٍ تحت الحقل لا داخله: داخل حقلٍ ضيّق (شبكةُ عمودين) كان يقصّ اسمَ
          الفرع نفسَه («الفرع الر…») ويترك التسميةَ كاملة — فيقرأ الموظّفُ المصدرَ ولا يقرأ الفرع. */}
      <p className="text-[11px] text-muted-foreground">{inference.sourceLabel}</p>
    </div>
  );
}

interface InferredFieldProps {
  label: string;
  /** القيمةُ المعروضة كما ردّها الخادم (أو الجلسة) — نصٌّ أو عنصر؛ لا تُشتقّ في الشاشة. */
  value: React.ReactNode;
  /** مصدرُ القيمة بكلمتين («حسابك المسجل»، «اليوم التشغيلي») — بلا تشكيل: نصٌّ صغير. */
  sourceLabel?: string;
  /** سطرُ شرحٍ اختياريّ تحت الحقل. */
  hint?: string;
  icon?: React.ReactNode;
  id?: string;
  className?: string;
}

/**
 * `InferredField` العامّ — عرضٌ للقراءة لقيمةٍ يعرفها الخادم أصلاً (اسمُ الفاعل، اليومُ
 * التشغيليّ، الفئةُ السعرية…). ليس مُدخَلاً: لا `disabled` ولا حدودٌ فعّالة، فلا يُخدَع المستخدم
 * بحقلٍ «معطَّل» ولا بـ`readOnly` يوهم بالإدخال. حقلُ الفرع له مكوّنُه المتخصّص أعلاه لأنّه وحده
 * يحمل تجاوزاً مشروعاً (الأدمن/المالك) وحرّاساً (`check:branch`).
 */
export function InferredField({
  label,
  value,
  sourceLabel,
  hint,
  icon,
  id = "inferred-field",
  className,
}: InferredFieldProps): React.ReactElement {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id}>{label}</Label>
      <div
        id={id}
        className="flex h-9 items-center gap-2 rounded-md border border-input bg-muted/30 px-3 text-sm"
      >
        {icon ?? <Sparkles aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className="truncate font-medium">{value}</span>
        {sourceLabel && (
          <span className="text-xs text-muted-foreground">({sourceLabel})</span>
        )}
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default InferredBranchField;
