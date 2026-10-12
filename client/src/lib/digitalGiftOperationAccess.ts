import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import {
  canViewOperationData,
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";

const COST_READS = new Set([
  "digitalCards.pricing.getMorningSheet",
  "digitalCards.pricing.preview",
  "digitalCards.pricing.mismatchReports",
  "gifts.report",
]);

/** Saved operation choices replace legacy UI gates without changing account identity. */
export function digitalGiftOperationAllowed(
  user: OperationUser | null | undefined,
  path: string,
  legacyAllowed = true,
): boolean {
  if (!user) return false;
  if (hasOperationPolicy(user) || user.isOwner === true) {
    if (COST_READS.has(path) && !digitalGiftCostVisible(user, false))
      return false;
    return operationDecision(user, path).allowed;
  }
  return legacyAllowed;
}

export function digitalGiftCostVisible(
  user: OperationUser | null | undefined,
  legacyVisible: boolean,
): boolean {
  if (!user) return false;
  return hasOperationPolicy(user) || user.isOwner === true
    ? canViewOperationData(user, "purchaseCost") &&
        canViewOperationData(user, "profitMargin")
    : legacyVisible;
}

/** Disabled queries can retain cached data; a revoked operation must hide that snapshot. */
export function digitalGiftQueryView<Q extends { data: unknown }>(
  user: OperationUser | null | undefined,
  path: string,
  result: Q,
): Omit<Q, "data"> & { data: Q["data"] | undefined } {
  return {
    ...result,
    data: digitalGiftOperationAllowed(user, path) ? result.data : undefined,
  };
}

export function useDigitalGiftOperationAccess() {
  const me = trpc.auth.me.useQuery();
  return useMemo(
    () => ({
      canonical: Boolean(
        me.data && (hasOperationPolicy(me.data) || me.data.isOwner),
      ),
      can: (path: string, legacyAllowed = true) =>
        digitalGiftOperationAllowed(me.data, path, legacyAllowed),
      query: <Q extends { data: unknown }>(path: string, result: Q) =>
        digitalGiftQueryView(me.data, path, result),
      costVisible: (legacyVisible = true) =>
        digitalGiftCostVisible(me.data, legacyVisible),
    }),
    [me.data],
  );
}
