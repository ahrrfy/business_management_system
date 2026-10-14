import {
  OPERATION_PERMISSIONS,
  getOperationPermission,
  legacyOperationPolicy,
  type OperationPolicy,
} from "./operationPermissions";
import {
  levelSatisfies,
  ROLE_TEMPLATES,
  SECTION_CASHIER_ROLES,
  type AccessLevel,
  type PermissionMap,
  type RoleKey,
} from "./permissions";

export const ROLE_DAILY_OPERATION_PATHS: Readonly<Record<string, readonly string[]>> = {
  cashier: [
    "shifts.current", "shifts.open", "catalog.posList", "sales.create", "sales.cancel",
    "returns.create", "returns.executeSalesReturnCart", "returns.getOpenRefundDrawers",
    "returns.getInvoice", "returns.inspectInvoiceForReturn", "returns.lookupItemForReturn",
    "returns.universalScan", "returns.forensicTrace", "returns.shifts",
    "returns.request", "returns.requests", "refundRails.preflight",
    "invoicePrinting.requestPrint", "invoicePrinting.requestReprint", "shifts.close",
  ],
  retail_cashier: [
    "shifts.current", "shifts.open", "catalog.posList", "sales.create", "sales.cancel",
    "returns.create", "returns.executeSalesReturnCart", "returns.getOpenRefundDrawers",
    "returns.getInvoice", "returns.inspectInvoiceForReturn", "returns.lookupItemForReturn",
    "returns.universalScan", "returns.forensicTrace", "returns.shifts",
    "returns.request", "returns.requests", "refundRails.preflight",
    "invoicePrinting.requestPrint", "invoicePrinting.requestReprint", "shifts.close",
  ],
  print_cashier: [
    "shifts.current", "shifts.open", "printPos.createSale", "sales.cancel", "returns.create",
    "returns.executeSalesReturnCart", "returns.getOpenRefundDrawers", "returns.getInvoice",
    "returns.inspectInvoiceForReturn", "returns.lookupItemForReturn",
    "returns.universalScan", "returns.forensicTrace", "returns.shifts",
    "returns.request", "returns.requests", "refundRails.preflight",
    "invoicePrinting.requestPrint", "invoicePrinting.requestReprint", "shifts.close",
  ],
  reception_clerk: [
    "shifts.current", "shifts.open", "workOrders.assignableStaff", "workOrders.assign",
    "reception.draftList", "reception.draftGet", "reception.draftSync", "reception.draftCommit",
    "reception.collectDeposit", "reception.collectOnInvoice", "reception.refundDeposit",
    "delivery.listParties", "delivery.dispatch", "delivery.dispatchInvoice",
    "delivery.reassignConsignment", "delivery.cancelAssignment", "delivery.settlementPreview",
    "delivery.settle", "delivery.settleDaily", "sales.cancel", "sales.correct", "sales.reissue",
    "returns.create", "returns.executeSalesReturnCart", "returns.getOpenRefundDrawers",
    "returns.getInvoice", "returns.inspectInvoiceForReturn", "returns.lookupItemForReturn",
    "returns.universalScan", "returns.forensicTrace", "returns.shifts",
    "returns.request", "returns.requests", "refundRails.preflight",
    "invoicePrinting.requestPrint",
    "invoicePrinting.requestReprint", "shifts.report", "shifts.handoverRecipients", "shifts.close",
  ],
  sales_rep: [
    "customers.list", "customers.create", "quotations.list", "quotations.create",
    "quotations.update", "quotations.convert", "quotations.setStatus",
  ],
  purchasing: [
    "purchases.list", "purchases.createOrder", "purchases.updateOrder", "purchases.confirmOrder",
    "purchaseReturnGovernance.requestReturn", "purchaseReturns.list",
  ],
  warehouse: [
    "inventory.movements", "inventory.transferBatch", "inventory.transferReceive", "stocktakes.create",
    "stocktakes.countSheets", "stocktakes.firstSign",
  ],
  print_operator: [
    "workOrders.list", "workOrders.get", "workOrders.start", "workOrders.setMaterials",
    "workOrders.markReady",
  ],
  courier: [
    "delivery.consignments", "delivery.staffHandover", "delivery.staffConfirm",
    "delivery.staffMarkFailed", "delivery.declareReturn",
  ],
  accountant: [
    "vouchers.list", "vouchers.create", "expenses.list", "expenses.create",
    "reports.monthCloseReadiness", "reports.monthlyClosePack",
  ],
  manager: [
    "salesControl.list", "salesControl.approve", "workOrders.assign", "stocktakes.approve",
    "delivery.settle", "delivery.settleDaily",
  ],
  auditor: [
    "reports.salesReport", "reports.inventoryValuation", "audit.list", "audit.facets",
  ],
  admin: [],
  user: [],
};

const CASHIER_PROFILE_KEYS = new Set(["cashier", "retail_cashier", "print_cashier", "reception_clerk"]);
const DAILY_PROFILE_MODULE: Readonly<Record<string, string>> = {
  cashier: "sales",
  retail_cashier: "sales",
  print_cashier: "pos",
  reception_clerk: "workorders",
};

const ACCESS_LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  NONE: 0,
  READ: 1,
  FULL: 2,
};

function existingDelegablePaths(paths: readonly string[]): string[] {
  return paths.filter((path) => getOperationPermission(path)?.delegable === true);
}

export function dailyOperationPaths(roleKey: string, baseRole?: string): readonly string[] {
  return existingDelegablePaths(
    ROLE_DAILY_OPERATION_PATHS[roleKey] ?? ROLE_DAILY_OPERATION_PATHS[baseRole ?? "user"] ?? [],
  );
}

/** قالب كامل؛ المهام اليومية منح صريح، والمشتريات والمالية العامة محجوبة عن الكاشيرات. */
export function buildDefaultRoleOperationPolicy(
  roleKey: string,
  baseRole: RoleKey,
  modules: PermissionMap,
): OperationPolicy {
  // Let the compatibility bridge derive only the real diff from the base-role
  // template. Passing the full resolved map as an explicit override turns every
  // template module into an intentional grant and can bypass an operation's
  // role allowlist (for example cashier -> salesControl.approve).
  const policy = legacyOperationPolicy(baseRole, modules);
  const grants = { ...policy.grants };
  const profileModule = DAILY_PROFILE_MODULE[roleKey];
  const profileDefaults =
    SECTION_CASHIER_ROLES.find((role) => role.key === roleKey)?.permissions ??
    ROLE_TEMPLATES[baseRole];
  for (const path of dailyOperationPaths(roleKey, baseRole)) {
    const operation = getOperationPermission(path);
    const operationModules = operation?.module?.split("|") ?? [];
    const requiredLevel = operation?.level === "READ" ? "READ" : "FULL";
    const moduleAllowed = operationModules.some((moduleKey) =>
      levelSatisfies(modules[moduleKey], requiredLevel),
    );
    const profileAllowed = profileModule
      ? levelSatisfies(modules[profileModule], "FULL")
      : moduleAllowed;
    // Some station presets intentionally bridge a daily operation through the
    // station module (for example print POS cancellation while retail sales is
    // hidden). Preserve that reviewed default, but never restore a module that
    // an administrator lowered from this profile's own baseline.
    const unchangedProfileBridge =
      operationModules.length > 0 &&
      operationModules.every((moduleKey) =>
        levelSatisfies(modules[moduleKey], requiredLevel) ||
        ACCESS_LEVEL_RANK[modules[moduleKey] ?? "NONE"] >=
          ACCESS_LEVEL_RANK[profileDefaults[moduleKey] ?? "NONE"],
      );
    if (
      operation?.delegable &&
      profileAllowed &&
      (moduleAllowed || unchangedProfileBridge)
    ) {
      grants[operation.key] = true;
    }
  }
  if (CASHIER_PROFILE_KEYS.has(roleKey)) {
    for (const operation of OPERATION_PERMISSIONS) {
      if (!operation.delegable) continue;
      if (
        operation.path.startsWith("purchases.") ||
        operation.path.startsWith("purchaseReturns.") ||
        operation.path.startsWith("supplierPayments.") ||
        operation.path.startsWith("accounts.") ||
        operation.path.startsWith("closing.") ||
        operation.path.startsWith("statutoryAccounting.")
      ) grants[operation.key] = false;
    }
  }
  return {
    ...policy,
    grants,
    dataVisibility: CASHIER_PROFILE_KEYS.has(roleKey)
      ? { purchaseCost: false, profitMargin: false }
      : policy.dataVisibility,
  };
}

export function hasRoleOperationPreset(roleKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_DAILY_OPERATION_PATHS, roleKey);
}
