import * as React from "react";
import {
  Ban,
  FileWarning,
  Info,
  Loader2,
  Lock,
  Pencil,
  Route,
  ShieldAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import { ACTION_LABELS } from "@shared/actionLabels";
import {
  DOCUMENT_ACTIONS,
  DOCUMENT_ACTION_AR,
  DOCUMENT_ACTION_PATH,
  DOCUMENT_EDIT_SCOPE,
  DOCUMENT_KIND_AR,
  documentActionBar,
  isDocumentDeadEnd,
  type DocumentAction,
  type DocumentFacts,
} from "@shared/documentActions";

import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { Button } from "./button";

/**
 * **ActionRail** — شريطُ أفعال المستند الأربعة (تعديل · إلغاء · عكس · تصحيح) في مكانٍ واحد،
 * **يعرضُ الممنوعَ ومعه سببُه ومخرجُه** بدل أن يُخفيه أو يُطفئه صامتاً.
 *
 * ## العلّة المقيسة التي يعالجها
 *
 * الأفعالُ اليوم متناثرةٌ في الشاشات، وكلُّ شاشةٍ تشتقّ بنفسها متى تُظهر الزرّ. المثالُ الحيّ في
 * [`client/src/pages/InvoiceDetail.tsx`]: `canFullCorrect` و`isCancellable` و
 * `canReverseWorkOrderInvoice` شروطٌ مكتوبةٌ يدوياً، والزرُّ يختفي بـ`&&` **بلا كلمةٍ واحدة**
 * تقول لِمَ. فيقف الموظّف أمام مستندٍ صامت: لا زرَّ ولا سبب، فيظنّ النظام معطوباً أو صلاحيتَه
 * منزوعة — وكلاهما غالباً غيرُ صحيح.
 *
 * ⇒ هذا المكوّن **لا يقرّر شيئاً**. القرارُ كلُّه في [`shared/documentActions.ts`]، وكلُّ قاعدةٍ
 * هناك مقروءةٌ من حارسٍ قائمٍ في الخادم وفوقها ملفُّه وسطرُه. مهمّةُ الشريط **عرضُ ما يقوله**.
 *
 * ## لماذا يستقبل `document` (الحقائق) لا قائمةَ أحكامٍ جاهزة
 *
 * لأنّ الأحكام تُشتقّ داخلياً بـ`documentActionBar(document)` ⇒ **لا شاشةَ تستطيع تمريرَ حكمٍ
 * صنعتْه بيدها**، وهو بالضبط ما نُغلقه. وهي الحقائقُ التي تملكها الشاشة أصلاً (حالة، منشأ،
 * إرسالية…)، ولا إجراءَ خادميّاً يُرجع الأحكام اليوم. والدالّةُ نقيّةٌ ورخيصة.
 *
 * ⚠️ **`allowed: true` تعني «المستند يقبل الفعل» لا «هذا المستخدم يملكه»**: الصلاحيات وفصلُ
 * المهام وعزلُ الفرع خارجَ نطاق `documentActions` عمداً (§٢ من الملف). فمن يريد إخفاءَ فعلٍ
 * لانعدام الصلاحية يفعل ذلك في الشاشة — والإنفاذُ النهائيّ خادميٌّ دائماً على كل حال.
 *
 * ## عقدُ العرض
 *
 * · **مسموح** ⇐ زرٌّ حقيقيّ يستدعي `onAct(action)`. ولا يُستدعى `onAct` قطّ لفعلٍ ممنوع
 *   ⇒ الشريط لا يُطلق طلباً يعرف الخادمُ أنّه سيرفضه.
 * · **ممنوع** ⇐ بطاقةٌ تحمل: اسمَ الفعل + شارةَ «ممنوع الآن» أو «لا مسار في النظام»
 *   (تُشتقّ من `DOCUMENT_ACTION_PATH[kind][action] === null`) + `why` + `doThis`.
 *   والفرقُ بين الشارتين ليس تجميلاً: الأولى حالةٌ قد تتبدّل، والثانية غيابٌ بحكم التصميم
 *   (إذن الاستلام لا يُعدَّل أبداً — يُعكَس ثمّ يُعاد إنشاؤه).
 * · **تعديلٌ مسموح** ⇐ ومعه `DOCUMENT_EDIT_SCOPE` نصّاً ظاهراً. تحذيرُ `documentActions`
 *   حرفيّ: «فشاشةُ تعديلٍ تُظهر محرّرَ بنودٍ كاملاً هنا تَعِد بما لا يقع» — فاتورةُ البيع
 *   المثبَّتة تقبل الملاحظات وتاريخ الاستحقاق وحدهما.
 * · **الأربعةُ ممنوعة** ⇐ لافتةُ نهايةٍ مسدودة فوق القائمة (`isDocumentDeadEnd`).
 *
 * ## المخرجُ كزرّ (`exitFor`) — ولماذا هو بيد الشاشة لا بيد الشريط
 *
 * `doThis` في `documentActions` **نصٌّ حرٌّ بلا هدفٍ مُهيكَل**: لا مسارَ ولا مُعرّفَ مستندٍ ولا
 * فعلٌ مقترَح. فالشريطُ لا يستطيع اشتقاقَ زرِّ «افتح أمر الشغل» بصدق (لا يعرف رقمَه). ولذلك
 * يقبل `exitFor` اختيارياً: تُرجع الشاشةُ — وهي وحدها تملك المُعرّفات — زرّاً للمخرج، أو `null`
 * فيبقى النصُّ نصّاً. ⛔ **لا يُخترع مخرجٌ هنا**: مخرجٌ كاذب أسوأ من الاعتراف بالانسداد،
 * لأنّ الموظّف يجرّبه فيفشل ثمّ لا يصدّق الرسالة التالية.
 *
 * ## قيودٌ ملتزَمة
 * بلا إيموجي (`lucide-react` فقط) · منطقيّ الاتجاه (`start/end`) بلا `left/right` ·
 * الألوانُ من التوكنز والخطرُ بتوكن الخطر (`variant="destructive"`) · نصوصُ الانتظار من
 * `ACTION_LABELS` · هدفُ لمسٍ ≥ 44px (`--ui-control` = 2.75rem) لأنّ الكاشير يُستعمل باللمس.
 */

/** زرُّ مخرجٍ تصنعه الشاشة لبطاقةِ منع — الشريطُ يعرضه ولا يخترعه. */
export interface ActionRailExit {
  /** نصُّ الزرّ. فعلٌ صريح: «افتح أمر الشغل»، «افتح شاشة الأقساط». */
  label: string;
  onClick: () => void;
  /** أيقونةُ `lucide-react` اختيارية. الافتراضيّ `Route`. */
  icon?: LucideIcon;
}

export interface ActionRailProps {
  /**
   * حقائقُ المستند كما يعرّفها [`shared/documentActions.ts`]. الشريطُ يشتقّ منها الأحكامَ
   * الأربعة بنفسه — فلا تُمرَّر إليه أحكامٌ محسوبةٌ في الشاشة.
   */
  document: DocumentFacts;
  /** يُستدعى للفعل **المسموح** وحده. */
  onAct: (action: DocumentAction) => void;
  /** الفعلُ الجاري تنفيذه الآن — يُظهر دوّارَه ويقفل بقيّةَ الأزرار حتى ينتهي. */
  isPending?: DocumentAction | null;
  /** مخرجٌ عمليٌّ لبطاقة المنع (انظر `ActionRailExit`). `null` ⇒ يبقى `doThis` نصّاً. */
  exitFor?: (context: {
    action: DocumentAction;
    why: string;
    doThis: string;
  }) => ActionRailExit | null | undefined;
  className?: string;
}

const ACTION_ICON: Record<DocumentAction, LucideIcon> = {
  EDIT: Pencil,
  CANCEL: Ban,
  REVERSE: Undo2,
  CORRECT: FileWarning,
};

/**
 * الفعلُ الخطر = ما يعكس مالاً ومخزوناً وذمّةً معاً. يأخذ `variant="destructive"` (توكن الخطر)،
 * وما عداه `outline` — فلا يتساوى «تعديل ملاحظة» بصرياً مع «إلغاء فاتورة».
 */
const DESTRUCTIVE_ACTIONS: ReadonlySet<DocumentAction> = new Set<DocumentAction>([
  "CANCEL",
  "REVERSE",
]);

/** نصوصُ الانتظار — من القاموس المشترك وحده (حارس `check:loading-strings`). */
const PENDING_LABEL: Record<DocumentAction, string> = {
  EDIT: ACTION_LABELS.saving,
  CANCEL: ACTION_LABELS.cancelling,
  REVERSE: ACTION_LABELS.processing,
  CORRECT: ACTION_LABELS.processing,
};

export function ActionRail({
  document: facts,
  onAct,
  isPending = null,
  exitFor,
  className,
}: ActionRailProps) {
  const bar = React.useMemo(() => documentActionBar(facts), [facts]);
  const deadEnd = React.useMemo(() => isDocumentDeadEnd(facts), [facts]);
  const kindAr = DOCUMENT_KIND_AR[facts.kind];
  const busy = isPending != null;

  return (
    <section
      data-slot="action-rail"
      aria-label={`أفعال ${kindAr}`}
      aria-busy={busy || undefined}
      className={cn("flex w-full flex-col gap-3 text-start", className)}
    >
      {deadEnd ? (
        <div
          role="status"
          data-slot="action-rail-dead-end"
          className="flex items-start gap-2 rounded-[var(--ui-radius-card)] bg-[var(--sem-warn-bg)] p-3 text-[var(--sem-warn)]"
        >
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="text-sm leading-relaxed">
            لا فعل مفتوح على هذا المستند الآن — الأربعة ممنوعة. السبب والمخرج لكل واحد منها
            مذكوران أدناه.
          </p>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2">
        {DOCUMENT_ACTIONS.map((action) => {
          const verdict = bar[action];
          const Icon = ACTION_ICON[action];
          const actionAr = DOCUMENT_ACTION_AR[action];

          if (verdict.allowed) {
            const pendingThis = isPending === action;
            return (
              <li
                key={action}
                data-slot="action-rail-item"
                data-action={action}
                data-allowed="true"
                className="flex flex-col gap-1"
              >
                <Button
                  type="button"
                  variant={DESTRUCTIVE_ACTIONS.has(action) ? "destructive" : "outline"}
                  onClick={() => onAct(action)}
                  disabled={busy}
                  aria-busy={pendingThis || undefined}
                  className="min-h-[var(--ui-control)] w-full justify-start"
                >
                  {pendingThis ? (
                    <Loader2 aria-hidden className="size-4 animate-spin" />
                  ) : (
                    <Icon aria-hidden className="size-4" />
                  )}
                  <span>{pendingThis ? PENDING_LABEL[action] : actionAr}</span>
                </Button>

                {/* نطاقُ التعديل ظاهرٌ دائماً: «مسموح» هنا أضيقُ بكثيرٍ ممّا يوحي اسمُ الفعل. */}
                {action === "EDIT" ? (
                  <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span>نطاق التعديل: {DOCUMENT_EDIT_SCOPE[facts.kind]}</span>
                  </p>
                ) : null}
              </li>
            );
          }

          // ممنوع: يُعرَض كاملاً — لا إخفاء ولا إطفاء صامت.
          const noPath = DOCUMENT_ACTION_PATH[facts.kind][action] === null;
          const exit = exitFor?.({ action, why: verdict.why, doThis: verdict.doThis }) ?? null;
          const ExitIcon = exit?.icon ?? Route;

          return (
            <li
              key={action}
              data-slot="action-rail-item"
              data-action={action}
              data-allowed="false"
              className="flex flex-col gap-1.5 rounded-[var(--ui-radius-card)] border bg-muted/40 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">{actionAr}</span>
                <Badge variant={noPath ? "neutral" : "warning"}>
                  <Lock aria-hidden />
                  {noPath ? "لا مسار في النظام" : "ممنوع الآن"}
                </Badge>
              </div>

              <p className="text-sm leading-relaxed">{verdict.why}</p>

              <div className="flex items-start gap-2">
                <Route aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--sem-info)]" />
                <p className="text-sm leading-relaxed text-muted-foreground">{verdict.doThis}</p>
              </div>

              {exit ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={exit.onClick}
                  disabled={busy}
                  className="mt-1 min-h-[var(--ui-control)] self-start"
                >
                  <ExitIcon aria-hidden className="size-4" />
                  <span>{exit.label}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
