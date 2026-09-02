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
import { isRolloutOn } from "../../config/rolloutFlags";
import type { Actor } from "../tx";

/** هل الفاعل هو المالك؟ `isOwner` هو المصدر — لا الدور. */
function actorIsOwner(actor: Pick<Actor, "isOwner">): boolean {
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
 * حين يكون العلَم مطفأً تُرجع `executeNow: false` دائماً — أي «أنشئ الطلب كما اليوم»،
 * فلا يتغيّر مسارٌ واحد.
 */
export function planApproval(args: {
  actor: Pick<Actor, "isOwner">;
  trigger: ApprovalTrigger | null;
}): ApprovalPlan {
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
  actor: Pick<Actor, "isOwner">;
  trigger: ApprovalTrigger;
  /** وصفٌ قصيرٌ للمستند يظهر في الرسالة: «طلب دفع مورّد SP-42». */
  subject: string;
  legacy: () => void;
}): void {
  if (!isRolloutOn("ownerOnlyApproval")) {
    args.legacy();
    return;
  }
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
