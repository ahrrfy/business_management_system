import {
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

/** Keep existing account behavior until migrated; a saved policy delegates only the exact operation. */
export function canLifecycleOperation(
  user: OperationUser | null | undefined,
  path: string,
  legacyAllowed: boolean,
): boolean {
  if (!user) return false;
  return hasOperationPolicy(user)
    ? operationDecision(user, path).allowed
    : legacyAllowed;
}
