import { trpc } from "@/lib/trpc";
import { useCallback } from "react";
import {
  canViewOperationData,
  getOperationPermission,
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

/** Match an explicit operation while retaining untouched legacy UI and protected authority. */
export function catalogPeopleOperationAllowed(
  user: OperationUser | null | undefined,
  path: string,
  legacyAllowed = true,
): boolean {
  if (!user) return false;
  const operation = getOperationPermission(path);
  if (operation && !operation.delegable) {
    return operation.reservedKind === "AUTHORITY"
      ? legacyAllowed && operationDecision(user, path).allowed
      : legacyAllowed;
  }
  return hasOperationPolicy(user) || user.isOwner === true
    ? operationDecision(user, path).allowed
    : legacyAllowed;
}

export function useCatalogPeopleOperationAccess() {
  const me = trpc.auth.me.useQuery();
  const user = me.data as OperationUser | null | undefined;
  const can = useCallback(
    (path: string, legacyAllowed = true) =>
      catalogPeopleOperationAllowed(user, path, legacyAllowed),
    [user],
  );
  return {
    can,
    canViewCost: (legacyAllowed: boolean) =>
      user && hasOperationPolicy(user)
        ? canViewOperationData(user, "purchaseCost") &&
          canViewOperationData(user, "profitMargin")
        : user?.isOwner === true || legacyAllowed,
  };
}
