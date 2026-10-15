import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { canCrossBranches } from "@shared/predicates";
import {
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

export interface CommissionAuthorityUser extends OperationUser {
  branchId?: number | null;
}

const DELEGABLE_BRANCH_WRITES = new Set([
  "commissions.plans.assign",
  "commissions.plans.endAssignment",
  "commissions.targets.saveAll",
  "commissions.targets.copyFromPrevious",
  "commissions.runs.compute",
  "commissions.runs.approve",
]);

/**
 * نطاق وحدة العمولات لا يُستنتَج من مستوى FULL وحده:
 * - المالك/الأدمن، أو المحاسب المركزي غير المسند لفرع، يملكون نطاق الشركة.
 * - مدير الفرع يملك فرعه المثبّت فقط.
 * - بقية حاملي READ يُقصرون على فرعهم؛ غياب الفرع يفشل مغلقاً.
 */
export function commissionReadScope(
  user: CommissionAuthorityUser,
): number | null {
  if (canCrossBranches(user)) return null;
  if (user.role === "accountant" && user.branchId == null) return null;
  const branchId = Number(user.branchId);
  if (Number.isInteger(branchId) && branchId > 0) return branchId;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "لا يمكن عرض عمولات الشركة بلا سلطة مالية مركزية أو فرع مُسنَد.",
  });
}

/** التفويض التشغيلي يمنح الكتابة في الفرع المسند؛ سلطة الشركة تبقى مستقلة. */
export function commissionWriteScope(
  user: CommissionAuthorityUser,
  path?: string,
): number | null {
  if (
    path &&
    DELEGABLE_BRANCH_WRITES.has(path) &&
    hasOperationPolicy(user) &&
    !user.isOwner
  ) {
    if (!operationDecision(user, path).allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({ what: "لم تُفوَّض بهذه العملية في العمولات.", why: "الاختيار الحالي لحسابك أو دورك يمنع هذه الحركة", doThis: "اطلب من الإدارة تفويض الحركة المطلوبة ثم حدّث الصفحة" }),
      });
    }
    // التفويض وحده لا يمنح نطاق الشركة، حتى للمحاسب المركزي بلا فرع.
    const branchId = Number(user.branchId);
    if (
      !canCrossBranches(user) &&
      (!Number.isInteger(branchId) || branchId <= 0)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({ what: "تعذّر تنفيذ عملية العمولات", why: "لا يوجد فرع تشغيلي مُسنَد للحساب", doThis: "اسند فرعاً للمستخدم لتنفيذ عملية العمولات المفوضة." }),
      });
    }
    return canCrossBranches(user) ? null : branchId;
  }
  const scope = commissionReadScope(user);
  if (scope == null) return null;
  if (user.role !== "manager") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "إدارة عمولات الفرع محصورة بمدير الفرع.",
    });
  }
  return scope;
}

/** العمليات التي تغيّر عقداً عاماً أو حالة تشغيلة الشركة لا يملكها مدير الفرع. */
export function assertCompanyCommissionAuthority(
  user: CommissionAuthorityUser,
): void {
  if (commissionWriteScope(user) != null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "هذا الإجراء على مستوى الشركة ويتطلب المالك/الأدمن أو المالية المركزية.",
    });
  }
}
