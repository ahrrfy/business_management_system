import { canonicalOperationAllowed, type StoredOperationSnapshot } from "./operationAuthority";

/** A production assignee must be able to perform both transitions, not merely manage the module. */
export function workOrderAssigneeAllowed(user: StoredOperationSnapshot, legacyAllowed: boolean, branchId?: number): boolean {
  // Built-in presets describe the role's own UI. They must not turn every built-in
  // account into an eligible production recipient; legacy assignment rules remain
  // authoritative until an administrator saves an exact role/user operation policy.
  if (!user.hasPersistedOperationPolicy) return legacyAllowed;
  const start = canonicalOperationAllowed(user, "workOrders.start");
  if (start === undefined) return legacyAllowed;
  return start && canonicalOperationAllowed(user, "workOrders.markReady") === true &&
    (branchId == null || (user.branchId != null && Number(user.branchId) === branchId));
}

/** Cash custody requires the receiver's own exact acceptance authority. */
export function cashHandoverRecipientAllowed(user: StoredOperationSnapshot, legacyAllowed: boolean): boolean {
  return canonicalOperationAllowed(user, "treasury.acceptHandoverReceipt") ?? legacyAllowed;
}
