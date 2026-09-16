/**
 * بوّابةُ الاعتماد الخادمية — المنفذُ الوحيد لتطبيق `shared/approvalPolicy.ts` على خدمةٍ.
 *
 * تُستدعى في موضعين متمايزين، ولكلٍّ دالّته — والخلطُ بينهما هو الخطأ المتوقَّع:
 *
 *   `planApproval`  **لحظةَ الفعل**: هل يُنفَّذ الآن أم يُنشَأ طلبٌ ينتظر المالك؟
 *   `assertApprover` **لحظةَ الاعتماد**: هل يحقّ لهذا الفاعل أن يعتمد هذا الطلب؟
 *
 * ## الانتقال آمنٌ بالتصميم
 *
 * كلتاهما تأخذان `legacy` — السلوكَ القائم اليوم — وتنفّذانه **حرفياً** حين يكون العلَم
 * `ownerOnlyApproval` مطفأً. فالإطفاء يُعيد النظام إلى ما هو عليه الآن بلا فرقٍ واحد،
 * وهذا شرطُ «إضافةٌ لا هدم» في الخطة.
 *
 * ⚠️ **ولا تُستدعى أيٌّ منهما بلا `trigger` مُصنَّف.** `null` قرارٌ صريحٌ معناه «لا خروجَ
 * مالٍ ولا محوَ أثر» ويُحذَف معه الاعتماد. تمريرُ `null` تكاسلاً يحذف ضابطاً حقيقياً —
 * ولذلك التصنيف يُثبَت بقراءة ما تكتبه الخدمة فعلاً، لا بالتخمين.
 */
import { TRPCError } from "@trpc/server";
import {
  ownerApprovalRequiredMessage,
  resolveApproval,
  type ApprovalDecision,
  type ApprovalTrigger,
} from "@shared/approvalPolicy";
import { eq } from "drizzle-orm";
import { users } from "../../../drizzle/schema";
import { isRolloutOn } from "../../config/rolloutFlags";
import type { Tx } from "../../db";
import type { Actor } from "../tx";

/**
 * فاعلٌ **حُسمت صفةُ ملكيّته** — `isOwner` إلزاميّةٌ هنا لا اختيارية.
 *
 * ⭐ هذا النوعُ هو العلاجُ البنيويّ لعطبٍ حقيقيّ أمسكته مراجعةٌ عدائية (٢/٩/٢٦): `Actor.isOwner`
 * **اختياريّة** ([`tx.ts`](../tx.ts))، وأكثرُ الراوترات تبني الفاعل من `ctx.user` **بلا** تمريرها.
 * فكان `actor.isOwner === true` يساوي `false` صامتاً لفاعلٍ **هو المالك فعلاً**، ⇒ تشغيلُ
 * العلَم يُنتج `FORBIDDEN` على **كلّ** اعتماد سند صرفٍ واعتماد عجزِ نقد — **للمالك نفسه**،
 * ولا مخرجَ لأنّ بوّابة وحدة فرق النقد لا تضمّ المالك أصلاً. و`tsc` أخضر، والاختبارُ أخضر،
 * لأنّه يستدعي `assertApprover` مباشرةً بـ`{ isOwner: true }` فلا يرى الراوتر البتّة.
 *
 * ⇒ الحلُّ **ليس فحصاً في وقت التشغيل** (يقلب القفلَ إلى انهيار)، بل **منعٌ عند التأليف**:
 * `boolean` لا `boolean | undefined` ⇒ كلُّ موضعٍ يمرّر فاعلاً غيرَ محسوم **يُحمِّر `tsc`**.
 * الخطأُ يُمنَع بنيوياً لا يُبلَّغ عنه بعد وقوعه — وهو جوهرُ «السهل الممتنع».
 */
export type ResolvedApprovalActor = { isOwner: boolean };

/**
 * يحسم صفةَ ملكيّة الفاعل **من القاعدة داخل المعاملة نفسها** — لا من حمولة الطلب.
 *
 * ⭐ لماذا القاعدة لا `ctx`: `isOwner` صفةُ تصعيدِ صلاحية، والثقةُ بما يصل مع الطلب أضعفُ
 * حارسٍ ممكن. وقد أثبت الواقعُ ذلك من الطرف الآخر: **٥٥ من ٦٤ راوتراً** لا تمرّرها أصلاً،
 * فكان الفاعلُ المالكُ يُقرأ «ليس مالكاً» صامتاً. قراءةُ القاعدة تُغلق البابين معاً — لا
 * راوترَ ينسى، ولا حمولةَ تدّعي.
 *
 * ويشترط أن يكون الحساب **نشطاً**: مالكٌ موقوفٌ لا يعتمد، وهو نفسُ شرط `approval.ts`
 * («اعتماد السندات محصور بحساب مالك نشط»).
 */
export async function resolveApprovalActor(
  tx: Tx,
  actor: Actor,
): Promise<Actor & ResolvedApprovalActor> {
  const [row] = await tx
    .select({ isOwner: users.isOwner, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  return { ...actor, isOwner: row?.isActive === true && row.isOwner === true };
}

/** هل الفاعل هو المالك؟ `isOwner` هو المصدر — لا الدور. */
function actorIsOwner(actor: ResolvedApprovalActor): boolean {
  return actor.isOwner === true;
}

export interface ApprovalPlan extends ApprovalDecision {
  /** يُنفَّذ الآن (لا بوّابة، أو المالك اعتمد نفسه). */
  executeNow: boolean;
  /** أُتيح بالسياسة الجديدة لا بالقديمة — يُكتب في أثر التدقيق. */
  underNewPolicy: boolean;
}

/**
 * **لحظةَ الفعل.** يقرّر: يُنفَّذ الآن، أم يُنشَأ طلبٌ ينتظر المالك؟
 *
 * قرار المالك الذاتي دائمٌ ولا يخضع لعلم طرح: المالك الذي بدأ الفعل هو أعلى سلطة،
 * فينفّذه ويعتمده في الخطوة نفسها. العلم يحكم فقط تبسيط دورة الموظفين القديمة.
 */
export function planApproval(args: {
  actor: ResolvedApprovalActor;
  trigger: ApprovalTrigger | null;
}): ApprovalPlan {
  if (actorIsOwner(args.actor)) {
    const decision = resolveApproval({
      trigger: args.trigger,
      actorIsOwner: true,
    });
    return {
      ...decision,
      executeNow: true,
      underNewPolicy: true,
    };
  }
  if (!isRolloutOn("ownerOnlyApproval")) {
    return {
      outcome: "NEEDS_OWNER",
      reason: "السياسة الجديدة مطفأة — يُتّبع مسار الطلب والاعتماد القائم.",
      soloExecution: false,
      executeNow: false,
      underNewPolicy: false,
    };
  }
  const decision = resolveApproval({
    trigger: args.trigger,
    actorIsOwner: actorIsOwner(args.actor),
  });
  return {
    ...decision,
    executeNow: decision.outcome !== "NEEDS_OWNER",
    underNewPolicy: true,
  };
}

/**
 * **لحظةَ الاعتماد.** يرمي إن كان الفاعل لا يحقّ له اعتمادُ هذا الطلب.
 *
 * بالسياسة الجديدة: **المالك حصراً** — لا مديرَ فرعٍ ولا محاسب، ولا فحصَ «مُنشئ ≠ مُعتمِد»
 * لأنّ المالك يعتمد نفسَه بقرارٍ صريح. وبالقديمة: يُنفَّذ `legacy` كما هو.
 *
 * @param legacy فحصُ فصل المهام القائم اليوم — يُمرَّر كدالّةٍ ويُنفَّذ عند الإطفاء وحده.
 */
export function assertApprover(args: {
  actor: ResolvedApprovalActor;
  /**
   * `null` قرارٌ صريحٌ معناه **لا بوّابةَ لهذا الفعل** — يمرّ أيُّ فاعلٍ اجتاز بوّابة الوحدة.
   * وهو الحالُ في الغالبية: الرفضُ في كل المسارات · اعتمادُ أمر الشراء · ترحيلُ فاتورة
   * المورّد · طلبُ الشراء الداخليّ. تصنيفُه يأتي من `shared/approvalTriggers.ts` بدليله.
   */
  trigger: ApprovalTrigger | null;
  /** وصفٌ قصيرٌ للمستند يظهر في الرسالة: «طلب دفع مورّد SP-42». */
  subject: string;
  legacy: () => void;
  /**
   * **ضابطٌ مُستبقًى بقرار مالكٍ صريح** على فعلٍ تصنيفُه `null`.
   *
   * ⭐ الحاجة إليه ظهرت من واقعٍ لا من تصميم (٢/٩/٢٦): سندُ القبض العاديّ (`IN` من مصدر
   * «أخرى») **لا يُخرج مالاً ولا يمحو أثراً** ⇒ تصنيفُه `null` بقاعدة المالك. لكنّه اليوم
   * **البوّابةُ الوحيدة على نقدٍ مجهول المصدر يدخل الخزينة**، وإسقاطُه يعني أنّ أيّ موظّفٍ
   * يُدخل مبلغاً بلا اعتماد. فقرّر المالك إبقاءه مُبوَّباً.
   *
   * ولذلك **لا يُضاف مُطلِقٌ ثالث** إلى `shared/approvalPolicy.ts` — قاعدةُ «حالتان لا ثالثة»
   * تبقى كما هي، والاستبقاءُ يقع هنا في طبقة الإنفاذ: الضابطُ **القائم** يُنفَّذ كما هو،
   * بلا سياسةٍ جديدة وبلا رسالةٍ جديدة. أي: لا تُبنى حالةٌ ثالثة، بل يُترك ما كان.
   *
   * ⛔ ولا يُمرَّر إلّا حيث يوجد قرارُ مالكٍ مكتوب — وإلّا صار باباً خلفياً يُعيد كلّ
   * بوّابةٍ أُلغيت بحجّة «الاحتياط»، فيضيع التبسيط الذي هو غرض السياسة كلّها.
   */
  retainLegacy?: boolean;
}): void {
  // قرار المالك النهائي لا يخضع لعلم طرح ولا لفصل المهام القديم: إذا كان المالك هو
  // المنشئ/الطالب فقد وافق بالفعل عند بدء العملية، فلا معنى لاعتماد ثان عليه.
  if (actorIsOwner(args.actor)) return;
  if (!isRolloutOn("ownerOnlyApproval")) {
    args.legacy();
    return;
  }
  // ضابطٌ استبقاه المالك: يُنفَّذ في الوضعين معاً، فلا يُسقطه تشغيلُ السياسة الجديدة.
  if (args.retainLegacy) {
    args.legacy();
    if (args.trigger === null) return;
  }
  // لا خروجَ مالٍ ولا محوَ أثر ⇒ لا بوّابة. وهذا **جوهرُ التبسيط**: خطواتُ الشراء الوسيطة
  // تمرّ بلا مقاطعة، فيُتمّها موظّفٌ واحد بدل أن تتفرّق على خمسة.
  if (args.trigger === null) return;
  if (actorIsOwner(args.actor)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: ownerApprovalRequiredMessage({ trigger: args.trigger, subject: args.subject }),
  });
}

/**
 * صفُّ سجلٍّ لكل فعلٍ نُفِّذ بشخصٍ واحد — يُغذّي شاشة «نُفِّذ بشخصٍ واحد».
 *
 * ⚠️ هذا **جزءٌ من السياسة لا زينةٌ بعدها**: حين يصير المالك المُعتمِد الوحيد، التقريرُ
 * يحلّ محلّ الفصل. بلا هذا السجلّ تصير القاعدة تبسيطاً بلا رقابة.
 */
export interface SoloExecutionRecord {
  actorUserId: number;
  trigger: ApprovalTrigger | null;
  outcome: ApprovalDecision["outcome"];
  reason: string;
  subject: string;
}

/** يبني صفَّ السجلّ من خطّةٍ ناتجة — أو `null` إن لم يكن الفعل منفَّذاً بشخصٍ واحد. */
export function soloExecutionRecord(args: {
  actor: Actor;
  plan: ApprovalPlan;
  trigger: ApprovalTrigger | null;
  subject: string;
}): SoloExecutionRecord | null {
  if (!args.plan.soloExecution || !args.plan.executeNow) return null;
  return {
    actorUserId: args.actor.userId,
    trigger: args.trigger,
    outcome: args.plan.outcome,
    reason: args.plan.reason,
    subject: args.subject,
  };
}
