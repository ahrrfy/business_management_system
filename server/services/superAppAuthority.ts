import {
  ROLE_TEMPLATES,
  resolvePermissions,
  type AccessLevel,
  type RoleKey,
} from "@shared/permissions";

import { canSeeCostForUser, canViewReports } from "../trpc";

export type SuperAppAuthorityUser = {
  role: string;
  isOwner?: boolean;
  branchId?: number | null;
  permissionsOverride?: unknown;
  roleLockedByInactiveCustomRole?: boolean;
};

/**
 * Server-owned authority used by every Super Arabia mobile projection.
 * UI state and caller parameters can never widen the tenant or branch scope.
 */
export function resolveSuperAppAuthority(user: SuperAppAuthorityUser) {
  const ownerOrAdmin = user.isOwner === true || user.role === "admin";
  const role = (ownerOrAdmin ? "admin" : user.role) as RoleKey;
  const permissions = ownerOrAdmin
    ? { ...ROLE_TEMPLATES.admin }
    : resolvePermissions(
        role,
        (user.permissionsOverride ?? null) as Record<string, AccessLevel> | null,
      );
  const allBranches = ownerOrAdmin;
  const requestedBranchId = user.branchId == null ? null : Number(user.branchId);
  const branchId =
    requestedBranchId != null &&
    Number.isInteger(requestedBranchId) &&
    requestedBranchId > 0
      ? requestedBranchId
      : null;

  return {
    role,
    permissions,
    scope: {
      branchId,
      allBranches,
      // A manager with no branch is explicitly empty-scoped, never company-wide.
      effectiveBranchId: allBranches ? null : (branchId ?? -1),
    },
    capabilities: {
      isOwner: user.isOwner === true,
      canSeeCost: ownerOrAdmin || canSeeCostForUser(user),
      canViewReports: ownerOrAdmin || canViewReports(user),
      isExecutive: ownerOrAdmin || role === "manager",
      roleDegraded: user.roleLockedByInactiveCustomRole === true,
    },
  };
}
