import { trpc } from "@/lib/trpc";
import { catalogPeopleOperationAllowed } from "@/lib/catalogPeopleOperationAccess";
import {
  hasModuleAccess,
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import type { PartyKind } from "./types";
const CRM_WRITE_ROLES = ["cashier", "manager", "sales_rep"] as const;
const SUPPLIER_WRITE_ROLES = ["manager", "warehouse", "purchasing"] as const;
export function useContactAccess(kind: PartyKind) {
  const me = trpc.auth.me.useQuery();
  const user = me.data;
  const role = (user?.role ?? "") as RoleKey;
  const override = (user?.permissionsOverride ?? null) as PermissionMap | null;
  const readLegacy = !!role && hasModuleAccess(role, override, "crm", "READ");
  const writeLegacy =
    !!role &&
    moduleAccessAllowed(role, override, "crm", "FULL", CRM_WRITE_ROLES);
  // This second gate is also enforced explicitly by contactsRouter, beyond operation grants.
  const supplierRead =
    kind === "customer" ||
    (!!role && hasModuleAccess(role, override, "suppliers", "READ"));
  const supplierWrite =
    kind === "customer" ||
    (!!role &&
      moduleAccessAllowed(
        role,
        override,
        "suppliers",
        "FULL",
        SUPPLIER_WRITE_ROLES,
      ));
  return {
    loading: me.isLoading,
    canViewMoney: role === "admin" || role === "manager",
    canRead: (path: string) =>
      supplierRead && catalogPeopleOperationAllowed(user, path, readLegacy),
    canWrite: (path: string) =>
      supplierWrite && catalogPeopleOperationAllowed(user, path, writeLegacy),
  };
}
export type ContactAccess = ReturnType<typeof useContactAccess>;
