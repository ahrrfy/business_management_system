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
import { AlertCircle, Building2, Pencil, X } from "lucide-react";
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
  const showPicker = pickerOpen || inference.status === "unassigned";

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
        <span>
          {inference.message ??
            "تعذّرت قراءةُ جلستك · انتهت الجلسة أو لم تُقبل · سجّل الدخول مجدّداً."}
        </span>
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
          disabled={disabled}
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
    <div
      id={id}
      className="flex h-9 items-center gap-2 rounded-md border border-input bg-muted/30 px-3 text-sm"
      // ⚠️ لا `disabled`/`aria-disabled` هنا: الحقلُ **يعرض** لا يُدخل — فتعطيلُه بصرياً يخدع.
      // القراءةُ العارضة تُعرَف بغياب الحدود الفعّالة والخلفيّة الرماديّة.
    >
      <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium">{displayName}</span>
      <span className="text-xs text-muted-foreground">
        ({inference.sourceLabel})
      </span>
      {canPick && (
        <button
          type="button"
          onClick={onOpenPicker}
          className="ms-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Pencil aria-hidden className="size-3" />
          تغيير
        </button>
      )}
    </div>
  );
}

/**
 * الحقول المستنتَجة الأخرى (يوم تشغيليّ، فئة سعرية، طريقة دفع افتراضية) لها نفس النمط لكنها
 * ليست حاجةً حاكمةً في هذه الشريحة — تُبنى عند حاجةِ الشاشة الفعليّة. المُصدَّرُ هنا الآن هو
 * حقلُ الفرع لأنّه ٦٩ إجراءً في الجرد الحاكم (٢/٩/٢٦) وحرّاسُ `check:branch` تدور حوله.
 */
export default InferredBranchField;
