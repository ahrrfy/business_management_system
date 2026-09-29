import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";

// ─── سلطة الفرع الموحّدة (قرار المالك ١٢/٨/٢٦: عزل مدير الفرع) ──────────────────
// مصدرُ حقيقةٍ واحدٌ لِـ«مَن يعبُر الفروع؟». وحدةٌ ورقة (لا تستورد شيئاً من الخادم) كي تستعملها
// طبقتا الراوتر والخدمة بلا دورات استيراد (trpc.ts يستورد خدمات ⇒ لا يصحّ أن تستورد الخدمات trpc.ts).
//
// **القاعدة الحاكمة:** يعبُر كلَّ الفروع (قراءةً وكتابةً) = admin (تصحيح إداريّ) + المالك isOwner فقط.
// مدير الفرع (role="manager" بلا isOwner) **ليس منهم** ⇒ مقيَّدٌ بفرعه المُسنَد قراءةً وكتابةً.
//
// ملاحظة: المالك يُطبَّع إلى role="admin" في context.ts (normalizeOwnerAuthority) قبل أيّ
// middleware/خدمة، لذا في طبقة الخدمة (actor.role مُطبَّع) يكفي role==="admin"؛ ونُبقي فحص isOwner
// صراحةً دفاعاً في العمق (حين تُمرَّر البصمة كاملةً كما في ctx.user).

/** هل يعبُر هذا الفاعل كلَّ الفروع؟ (المالك/الأدمن نعم؛ مدير الفرع لا — قرار المالك ١٢/٨). */
export function canCrossBranches(actor: { role?: string | null; isOwner?: boolean | null } | null | undefined): boolean {
  if (!actor) return false;
  return actor.role === "admin" || actor.isOwner === true;
}

/**
 * يحلّ فرع الفاعل مع إلغاء الهبوط الصامت على الفرع 1 (VULN-RBAC-02):
 * - إذا كان لدى المستخدم فرعٌ مُسنَد: يُعاد فوراً.
 * - إذا كان مالكاً أو أدمن (canCrossBranches): يُلزم تمرير inputBranchId وإلا BAD_REQUEST.
 * - غير ذلك (مستخدم بلا فرع): يُرفض صراحةً بـ FORBIDDEN.
 */
export function resolveActorBranchId(
  ctx: { user: { role?: string | null; isOwner?: boolean | null; branchId?: number | null } },
  inputBranchId?: number | null,
): number {
  if (canCrossBranches(ctx.user)) {
    if (inputBranchId != null) {
      const parsed = Number(inputBranchId);
      if (parsed > 0) return parsed;
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "معرف الفرع غير صالح",
          why: "معرف الفرع المدخل يجب أن يكون رقماً موجباً أكبر من صفر",
          doThis: "تحقق من معرف الفرع المدخل وأعد المحاولة",
        }),
      });
    }
    if (ctx.user.branchId != null) {
      return Number(ctx.user.branchId);
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "يجب تحديد الفرع (branchId)",
        why: "المستخدم يملك صلاحية إدارة الفروع ويجب اختيار الفرع المستهدف صراحة",
        doThis: "اختر الفرع من القائمة المتاحة قبل المتابعة",
      }),
    });
  }

  if (ctx.user.branchId != null) {
    return Number(ctx.user.branchId);
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: appErrorMessage({
      what: "لا فرع مُسنَد لهذا المستخدم",
      why: "المستخدم غير مخوّل بالعبور بين الفروع ولا يملك فرعاً مسنداً في حسابه",
      doThis: "راجع مسؤول النظام لتعيين فرع لحسابك",
    }),
  });
}
