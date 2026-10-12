import {
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

/** Preserve the old UI gate until a canonical policy is saved; exact grants then decide. */
export function lifecycleActionAllowed(
  user: OperationUser | null | undefined,
  path: string,
  legacyAllowed: boolean,
): boolean {
  if (!user) return false;
  return hasOperationPolicy(user) || user.isOwner === true
    ? operationDecision(user, path).allowed
    : legacyAllowed;
}
