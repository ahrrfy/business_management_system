import { TRPCError } from "@trpc/server";

export interface CommissionAuthorityUser {
  role: string;
  branchId?: number | null;
  isOwner?: boolean | null;
}

/**
 * نطاق وحدة العمولات لا يُستنتَج من مستوى FULL وحده:
 * - المالك/الأدمن، أو المحاسب المركزي غير المسند لفرع، يملكون نطاق الشركة.
 * - مدير الفرع يملك فرعه المثبّت فقط.
 * - بقية حاملي READ يُقصرون على فرعهم؛ غياب الفرع يفشل مغلقاً.
 */
export function commissionReadScope(user: CommissionAuthorityUser): number | null {
  if (user.isOwner === true || user.role === "admin") return null;
  if (user.role === "accountant" && user.branchId == null) return null;
  const branchId = Number(user.branchId);
  if (Number.isInteger(branchId) && branchId > 0) return branchId;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "لا يمكن عرض عمولات الشركة بلا سلطة مالية مركزية أو فرع مُسنَد.",
  });
}

/** نطاق الكتابة: شركة للسلطة المركزية، وفرع ثابت لمدير الفرع فقط. */
export function commissionWriteScope(user: CommissionAuthorityUser): number | null {
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
export function assertCompanyCommissionAuthority(user: CommissionAuthorityUser): void {
  if (commissionWriteScope(user) != null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذا الإجراء على مستوى الشركة ويتطلب المالك/الأدمن أو المالية المركزية.",
    });
  }
}
