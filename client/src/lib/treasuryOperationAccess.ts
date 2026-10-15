import {
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

/** Exact display authority; document state, custody and branch checks remain server enforced. */
export function treasuryOperationAllowed(
  user: OperationUser | null | undefined,
  path: string,
  legacyAllowed: boolean,
): boolean {
  if (!user) return false;
  return hasOperationPolicy(user) || user.isOwner === true
    ? operationDecision(user, path).allowed
    : legacyAllowed;
}
