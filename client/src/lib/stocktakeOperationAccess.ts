import type { OperationUser } from "@shared/operationPermissions";
import { canLifecycleOperation } from "./lifecycleOperationAccess";

/** The review gate and exact actions stay independent from each other. */
export function stocktakeOperationAccess(
  user: OperationUser | null | undefined,
) {
  const canOperation = (path: string) =>
    canLifecycleOperation(user, path, true);
  const role = user?.role ?? "";
  const legacyManager = role === "admin" || role === "manager";
  const canReview = canLifecycleOperation(
    user,
    "stocktakes.review",
    legacyManager,
  );
  return { canOperation, role, canReview };
}
