import { TRPCError } from "@trpc/server";
import { canCrossBranches } from "@shared/predicates";

/**
 * Branch scope inside the tenant database selected by runWithCompany.
 * `branchId=null` is deliberately reserved for the company owner/admin.
 */
export type CompanyBranchScope = Readonly<{ branchId: number | null }>;

type ScopePrincipal = {
  role?: string | null;
  isOwner?: boolean | null;
  branchId?: number | null;
};

function positiveBranchId(value: unknown): number | null {
  const branchId = Number(value);
  return Number.isInteger(branchId) && branchId > 0 ? branchId : null;
}

/** Derive authority only from the authenticated principal, never request input. */
export function companyBranchScope(principal: ScopePrincipal): CompanyBranchScope {
  if (canCrossBranches(principal)) return { branchId: null };
  const branchId = positiveBranchId(principal.branchId);
  if (branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يوجد فرع مُسنَد لهذا المستخدم",
    });
  }
  return { branchId };
}

/**
 * Resolve a requested target branch without permitting a branch-scoped caller
 * to widen or move its scope. Company-wide callers may omit it only when the
 * resource itself permits a company-level/null branch.
 */
export function resolveTargetBranch(
  scope: CompanyBranchScope,
  requestedBranchId: number | null | undefined,
  options: { required: boolean },
): number | null {
  if (scope.branchId != null) {
    if (requestedBranchId != null && Number(requestedBranchId) !== scope.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن الوصول إلى فرع آخر" });
    }
    return scope.branchId;
  }

  const requested = positiveBranchId(requestedBranchId);
  if (requested != null) return requested;
  if (options.required) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الفرع" });
  }
  return null;
}

export function isBranchInScope(scope: CompanyBranchScope, branchId: number | null | undefined): boolean {
  return scope.branchId == null || (branchId != null && Number(branchId) === scope.branchId);
}
