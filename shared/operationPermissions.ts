import { createMongoAbility } from "@casl/ability";
import { z } from "zod";
import {
  ALL_PERMISSION_MODULE_KEYS,
  applyPermissionOverrides,
  canSeeCost,
  canUseDigitalCardsSellingStation,
  diffFromTemplate,
  deriveEffectiveAccess,
  levelSatisfies,
  moduleAccessAllowed,
  resolvePermissions,
  type AccessLevel,
  type EffectiveAccessSummary,
  type PermissionMap,
  type PosStation,
  type RoleKey,
} from "./permissions";
import { GENERATED_OPERATION_PERMISSIONS } from "./operationPermissionCatalog.generated";
import { canCheckReceptionDuplicates } from "./receptionDuplicateOrders";

/** The catalog is generated from real tRPC paths, never from display aliases. */
export interface OperationPermission {
  key: string;
  path: string;
  kind: "query" | "mutation";
  module: string | null;
  navigationModule?: string | null;
  roles: readonly string[];
  authority: string;
  branch: boolean | string;
  label: string;
  domain: string;
  resource: string;
  lifecycleStage: string;
  legacyAliases: readonly string[];
  delegable: boolean;
  requiresCostVisibility?: boolean;
  requiresLegacyReview?: boolean;
  reservedKind?: "AUTHORITY" | "IDENTITY" | "PUBLIC" | "UNSUPPORTED" | "RETIRED" | null;
  /** The inherited legacy gate can require FULL even for a query. */
  level?: string | null;
  procedure?: string;
  inheritedAuthority?: string | null;
  /** Only paths whose handler actually consumes the owner filter expose this choice. */
  supportsRecordScope?: boolean;
}

export const OPERATION_PERMISSIONS: readonly OperationPermission[] =
  GENERATED_OPERATION_PERMISSIONS as readonly OperationPermission[];

const operationByPath = new Map<string, OperationPermission>();
const operationByKey = new Map<string, OperationPermission>();
for (const operation of OPERATION_PERMISSIONS) {
  if (
    operation.key !== `operation.${operation.path}` ||
    operationByPath.has(operation.path) ||
    operationByKey.has(operation.key)
  ) {
    throw new Error(
      `Invalid or duplicate operation catalog path: ${operation.path}`,
    );
  }
  operationByPath.set(operation.path, operation);
  operationByKey.set(operation.key, operation);
}

export type OperationRecordScope = "OWN" | "BRANCH";
export type OperationDataField = "purchaseCost" | "profitMargin";

export interface OperationPolicy {
  version: 1;
  /** Role maps are complete policies; user maps are sparse overrides. */
  grants: Record<string, boolean>;
  recordScopes?: Record<string, OperationRecordScope>;
  dataVisibility?: Partial<Record<OperationDataField, boolean>>;
}

const policyShape = z
  .object({
    version: z.literal(1),
    grants: z.record(z.string(), z.boolean()),
    recordScopes: z.record(z.string(), z.enum(["OWN", "BRANCH"])).optional(),
    dataVisibility: z
      .object({
        purchaseCost: z.boolean().optional(),
        profitMargin: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Reject unknown paths and reserved authority; aliases are migration inputs only. */
export const operationPolicySchema = policyShape.transform((policy) => {
  const grants = { ...policy.grants };
  const recordScopes = policy.recordScopes ? { ...policy.recordScopes } : undefined;
  // Only explicitly retired catalog paths are safe to remove from persisted full maps.
  for (const key of Object.keys(grants))
    if (getOperationPermission(key)?.reservedKind === "RETIRED") delete grants[key];
  for (const key of Object.keys(recordScopes ?? {}))
    if (getOperationPermission(key)?.reservedKind === "RETIRED") delete recordScopes![key];
  return { ...policy, grants, ...(recordScopes ? { recordScopes } : {}) };
}).superRefine((policy, ctx) => {
  const visibility = policy.dataVisibility;
  if (visibility && visibility.purchaseCost !== visibility.profitMargin) {
    ctx.addIssue({
      code: "custom",
      path: ["dataVisibility"],
      message:
        "عرض التكلفة والربح صلاحية واحدة؛ يجب حفظ الخيارين معاً بالقيمة نفسها",
    });
  }
  for (const key of Object.keys(policy.grants)) {
    const operation = operationByKey.get(key);
    if (!operation?.delegable) {
      ctx.addIssue({
        code: "custom",
        path: ["grants", key],
        message: operation
          ? "هذه العملية محمية ولا تقبل التفويض من المصفوفة"
          : "مفتاح العملية غير مسجل في كتالوج الصلاحيات",
      });
    }
  }
  for (const key of Object.keys(policy.recordScopes ?? {})) {
    const operation = operationByKey.get(key);
    if (!operation?.delegable || operation.supportsRecordScope !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["recordScopes", key],
        message: "نطاق السجلات غير متاح لهذه العملية",
      });
    }
  }
});

export function getOperationPermission(
  pathOrKey: string,
): OperationPermission | undefined {
  return operationByPath.get(pathOrKey) ?? operationByKey.get(pathOrKey);
}

const own = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

function legacyMinimumLevel(operation: OperationPermission): AccessLevel {
  if (operation.level === "READ") return "READ";
  if (operation.level === "FULL" || operation.level === "WRITE") return "FULL";
  return operation.kind === "query" ? "READ" : "FULL";
}

function legacyAllowed(
  role: string,
  modules: PermissionMap,
  override: PermissionMap | null | undefined,
  operation: OperationPermission,
): boolean {
  if (operation.path === "invoicePrinting.authorizeBridge") return role !== "courier";
  if (role === "admin") return true;
  if (operation.authority === "unknown") return false;
  if (
    operation.inheritedAuthority === "raw-role" &&
    !operation.roles.includes(role)
  )
    return false;
  if (operation.authority === "raw-role") return operation.roles.includes(role);
  if (operation.procedure === "receptionDuplicateReadProcedure") return canCheckReceptionDuplicates(role, override);
  if (operation.procedure === "digitalCardsPosProcedure" && !canUseDigitalCardsSellingStation(role, override)) return false;
  if (operation.procedure === "customersReadProcedure") {
    if (override?.customers === "NONE" && role !== "cashier" && role !== "print_operator") return false;
    return levelSatisfies(override?.customers, "READ") ||
      moduleAccessAllowed(role, override, "crm", "READ", ["cashier", "manager", "sales_rep", "accountant"]) ||
      moduleAccessAllowed(role, override, "sales", "READ", ["cashier", "manager", "sales_rep"]) ||
      moduleAccessAllowed(role, override, "pos", "READ", ["cashier", "manager", "print_operator"]) ||
      moduleAccessAllowed(role, override, "workorders", "READ", ["cashier", "manager", "print_operator"]);
  }
  if (operation.procedure === "customersReceptionCreateProcedure") {
    return levelSatisfies(override?.customers, "FULL") ||
      moduleAccessAllowed(role, override, "crm", "FULL", ["cashier", "manager", "sales_rep", "print_operator"]) ||
      moduleAccessAllowed(role, override, "workorders", "FULL", ["cashier", "manager", "print_operator"]);
  }
  const moduleKeys = operation.module?.split("|").filter(Boolean) ?? [];
  if (moduleKeys.length === 0) {
    return (
      operation.roles.length === 0 ||
      operation.roles.includes(role) ||
      operation.roles.includes("authenticated-user")
    );
  }
  const allows = (moduleKey: string, minimum: AccessLevel): boolean =>
    operation.authority === "module-gate"
      ? moduleAccessAllowed(role, override, moduleKey, minimum, operation.roles)
      : levelSatisfies(modules[moduleKey], minimum);
  if (operation.procedure === "salesCorrectionProcedure") {
    return (allows("sales", "FULL") || allows("workorders", "FULL")) &&
      allows("products", "READ");
  }
  if (operation.procedure === "salesCorrectionComparisonProcedure") {
    return allows("sales", "FULL") ||
      (allows("workorders", "FULL") && allows("products", "READ"));
  }
  const levels = operation.level?.split("|") ?? [];
  if (levels.length > 1) {
    if (levels.length !== moduleKeys.length ||
        levels.some((level) => level !== "READ" && level !== "FULL" && level !== "WRITE")) return false;
    return moduleKeys.some((moduleKey, index) =>
      allows(moduleKey, levels[index] === "READ" ? "READ" : "FULL"));
  }
  return moduleKeys.some((moduleKey) => allows(moduleKey, legacyMinimumLevel(operation)));
}

/** Compatibility snapshot: only the real gate's own module can grant an operation. */
const CASHIER_OPERATIONAL_FINANCE_PATHS = new Set([
  "shifts.current", "shifts.open", "shifts.close", "shifts.cashDrop", "shifts.list", "shifts.report",
  "shifts.handoverRecipients", "shifts.eligibleVarianceApprovers",
  "treasury.getOpenShifts", "treasury.getRecentMovements", "refundRails.preflight",
]);
const COMPANY_FINANCE_DOMAINS = new Set([
  "reports", "accounts", "exchange", "closing", "statutoryAccounting", "cardAccount",
  "vouchers", "cashTransfers", "supplierPayments",
]);

export function legacyOperationPolicy(
  role: string,
  resolvedLegacyModules: PermissionMap,
  explicitOverride?: PermissionMap | null,
): OperationPolicy {
  const override =
    explicitOverride === undefined
      ? diffFromTemplate(role as RoleKey, resolvedLegacyModules)
      : explicitOverride;
  const grants: Record<string, boolean> = {};
  const recordScopes: Record<string, OperationRecordScope> = {};
  for (const operation of OPERATION_PERMISSIONS) {
    if (!operation.delegable) continue;
    // Converting a station cashier must not promote old shared module keys into
    // company financial authority. Administrators can select these exact actions explicitly.
    const cashierFinance = role === "cashier" && !CASHIER_OPERATIONAL_FINANCE_PATHS.has(operation.path) && (
      (operation.module ?? "").split("|").some(module => module === "treasury" || module === "reports") ||
      COMPANY_FINANCE_DOMAINS.has(operation.domain) || operation.path === "expenses.accrualCorrections"
    );
    grants[operation.key] = !cashierFinance && legacyAllowed(
      role,
      resolvedLegacyModules,
      override,
      operation,
    );
    if (operation.supportsRecordScope === true) {
      recordScopes[operation.key] =
        role === "admin" || role === "manager" ? "BRANCH" : "OWN";
    }
  }
  const seesCost =
    canSeeCost(role) &&
    (!override || (resolvedLegacyModules.reports ?? "NONE") !== "NONE");
  return {
    version: 1,
    grants,
    recordScopes,
    dataVisibility: {
      purchaseCost: seesCost,
      profitMargin: seesCost,
    },
  };
}

/**
 * A saved role denies every absent operation. User overrides inherit absent keys,
 * including explicit user DENY, without changing the role or another account.
 */
export function resolveOperationPolicy(
  role: string,
  modules: PermissionMap,
  rolePolicy?: OperationPolicy | null,
  userPolicy?: OperationPolicy | null,
  legacyOverride?: PermissionMap | null,
  legacyIndividual?: {
    permissionsOverride?: PermissionMap | null;
    atomicPermissions?: Record<string, boolean> | null;
    inheritedModules?: PermissionMap;
  },
): OperationPolicy {
  const legacy = legacyOperationPolicy(role, modules, legacyOverride);
  // Until this account is explicitly converted, preserve its own old grants and revocations.
  // A saved sparse user policy replaces the old individual matrix completely.
  const inherited = userPolicy == null && legacyIndividual
    ? applyLegacyIndividualOperationOverrides(
        rolePolicy ?? legacy,
        role,
        legacyIndividual.inheritedModules,
        legacyIndividual.permissionsOverride,
        legacyIndividual.atomicPermissions,
      )
    : rolePolicy ?? legacy;
  const grants: Record<string, boolean> = {};
  const recordScopes: Record<string, OperationRecordScope> = {};
  for (const operation of OPERATION_PERMISSIONS) {
    if (!operation.delegable) continue;
    const roleGrant = inherited.grants[operation.key] === true;
    grants[operation.key] =
      userPolicy && own(userPolicy.grants, operation.key)
        ? userPolicy.grants[operation.key] === true
        : roleGrant;
    if (operation.supportsRecordScope === true) {
      recordScopes[operation.key] =
        userPolicy?.recordScopes?.[operation.key] ??
        (rolePolicy
          ? (rolePolicy.recordScopes?.[operation.key] ?? "OWN")
          : (legacy.recordScopes?.[operation.key] ?? "OWN"));
    }
  }
  if (
    grants["operation.workOrders.start"] === true &&
    grants["operation.workOrders.markReady"] === true
  ) {
    const isFullLegacyUserSnapshot =
      userPolicy != null &&
      Object.keys(userPolicy.grants).length >= 50 &&
      userPolicy.grants["operation.workOrders.claim"] === false &&
      userPolicy.grants["operation.workOrders.release"] === false &&
      userPolicy.grants["operation.workOrders.setKanbanState"] === false;
    for (const companionPath of [
      "workOrders.list",
      "workOrders.counts",
      "workOrders.get",
      "workOrders.getByNumber",
      "workOrders.claim",
      "workOrders.release",
      "workOrders.setKanbanState",
      "workOrders.timeline",
      "workOrders.eventTimeline",
    ]) {
      const companion = getOperationPermission(companionPath);
      if (!companion?.delegable) continue;
      const explicitlyRevokedByUser =
        userPolicy != null &&
        own(userPolicy.grants, companion.key) &&
        userPolicy.grants[companion.key] === false &&
        (!isFullLegacyUserSnapshot || inherited.grants[companion.key] === true);
      if (!explicitlyRevokedByUser) {
        grants[companion.key] = true;
      }
    }
  }
  return {
    version: 1,
    grants,
    recordScopes,
    dataVisibility: {
      ...(rolePolicy
        ? {
            purchaseCost: false,
            profitMargin: false,
          }
        : legacy.dataVisibility),
      ...inherited.dataVisibility,
      ...userPolicy?.dataVisibility,
    },
  };
}

/** Preserve explicit old module grants relative to the inherited role, then apply its revocations. */
export function applyLegacyIndividualOperationOverrides(
  policy: OperationPolicy,
  role: string,
  inheritedModules: PermissionMap | undefined,
  rawModules?: PermissionMap | null,
  rawAtomic?: Record<string, boolean> | null,
): OperationPolicy {
  const baseModules = inheritedModules ?? resolvePermissions(role as RoleKey, null);
  const effectiveModules = applyPermissionOverrides(baseModules, rawModules ?? null);
  const baseLegacy = legacyOperationPolicy(
    role,
    baseModules,
    diffFromTemplate(role as RoleKey, baseModules),
  );
  const effectiveLegacy = legacyOperationPolicy(
    role,
    effectiveModules,
    diffFromTemplate(role as RoleKey, effectiveModules),
  );
  const grants = { ...policy.grants };
  for (const operation of OPERATION_PERMISSIONS) {
    if (
      operation.delegable &&
      effectiveLegacy.grants[operation.key] === true &&
      baseLegacy.grants[operation.key] !== true
    ) {
      grants[operation.key] = true;
    }
  }
  const denied = applyLegacyIndividualOperationDenials(
    { ...policy, grants },
    role,
    rawModules,
    rawAtomic,
  );
  const bridgedGrants = { ...denied.grants };
  const bothReturnAndVoidRevoked =
    rawAtomic?.["pos.return.create"] === false &&
    rawAtomic?.["pos.invoice.void"] === false;
  // Legacy print-cashier (pos:FULL) and reception-cashier (workorders:FULL)
  // accounts preserve their routine return workflow while migrating to named presets,
  // even when their legacy module map explicitly sets sales: "NONE".
  if (
    !bothReturnAndVoidRevoked &&
    (rawModules?.pos === "FULL" || rawModules?.workorders === "FULL")
  ) {
    for (const path of [
      "returns.create",
      "returns.getInvoice",
      "returns.inspectInvoiceForReturn",
      "returns.lookupItemForReturn",
      "returns.universalScan",
      "returns.forensicTrace",
      "returns.shifts",
      "returns.executeSalesReturnCart",
      "returns.getOpenRefundDrawers",
      "refundRails.preflight",
      ...(rawModules?.workorders === "FULL"
        ? ["returns.request", "returns.requests"]
        : []),
    ]) {
      const operation = getOperationPermission(path);
      if (operation?.delegable) bridgedGrants[operation.key] = true;
    }
  }
  return applyLegacyOperationDenials({ ...denied, grants: bridgedGrants }, rawAtomic);
}

/** Carry only explicit individual restrictions, never old template restrictions. */
export function applyLegacyIndividualOperationDenials(
  policy: OperationPolicy,
  role: string,
  rawModules?: PermissionMap | null,
  rawAtomic?: Record<string, boolean> | null,
): OperationPolicy {
  const full: PermissionMap = Object.fromEntries(ALL_PERMISSION_MODULE_KEYS.map((key) => [key, "FULL"]));
  const restricted = { ...full };
  let hasRestriction = false;
  for (const [key, level] of Object.entries(rawModules ?? {})) {
    if (level === "NONE" || level === "READ") {
      restricted[key] = level;
      hasRestriction = true;
    }
  }
  const grants = { ...policy.grants };
  if (hasRestriction) for (const operation of OPERATION_PERMISSIONS) {
    if (operation.delegable && legacyAllowed(role, full, full, operation) &&
        !legacyAllowed(role, restricted, restricted, operation)) grants[operation.key] = false;
  }
  const result = applyLegacyOperationDenials({ ...policy, grants }, rawAtomic);
  if (rawModules?.reports === "NONE") result.dataVisibility = { purchaseCost: false, profitMargin: false };
  return result;
}

export interface OperationUser {
  role: string;
  isOwner?: boolean | null;
  /** A resolved compatibility snapshot alone must not enable canonical gate bypass. */
  operationPolicyEnabled?: boolean;
  permissionsOverride?: unknown;
  atomicPermissions?: unknown;
  resolvedPermissions?: PermissionMap;
  resolvedOperationPolicy?: OperationPolicy | null;
  roleOperationPolicy?: OperationPolicy | null;
  operationPolicy?: OperationPolicy | null;
}

export type OperationDecisionSource =
  | "user"
  | "role"
  | "policy"
  | "legacy"
  | "owner"
  | "admin"
  | "protected"
  | "unknown";
export interface OperationDecision {
  allowed: boolean;
  key: string;
  source: OperationDecisionSource;
  reason: string;
  scope?: OperationRecordScope;
}

export function hasOperationPolicy(user: OperationUser): boolean {
  return (
    user.operationPolicyEnabled === true ||
    Boolean(user.roleOperationPolicy || user.operationPolicy)
  );
}

function effectivePolicy(user: OperationUser): OperationPolicy {
  if (user.resolvedOperationPolicy) return user.resolvedOperationPolicy;
  const override = user.permissionsOverride as PermissionMap | null | undefined;
  const atomic = user.atomicPermissions as Record<string, boolean> | null | undefined;
  const modules =
    user.resolvedPermissions ??
    resolvePermissions(user.role as RoleKey, override);
  return resolveOperationPolicy(
    user.role,
    modules,
    user.roleOperationPolicy,
    user.operationPolicy,
    override,
    user.operationPolicy == null && (override != null || atomic != null)
      ? {
          permissionsOverride: override,
          atomicPermissions: atomic,
          inheritedModules: resolvePermissions(user.role as RoleKey, null),
        }
      : undefined,
  );
}

/** CASL is an evaluator; the server still enforces state, branch and maker-checker rules. */
export function operationDecision(
  user: OperationUser,
  path: string,
): OperationDecision {
  const operation = getOperationPermission(path);
  if (!operation) {
    return {
      allowed: false,
      key: path.startsWith("operation.") ? path : `operation.${path}`,
      source: "unknown",
      reason: "العملية غير مسجلة في كتالوج الصلاحيات",
    };
  }
  if (operation.delegable && user.isOwner === true) {
    return { allowed: true, key: operation.key, source: "owner", reason: "سلطة المالك محفوظة", scope: "BRANCH" };
  }
  if (!operation.delegable) {
    const owner = operation.authority === "owner" && user.isOwner === true;
    const admin =
      (operation.authority === "admin" ||
        (operation.roles.length === 1 && operation.roles[0] === "admin")) &&
      user.role === "admin";
    return {
      allowed: owner || admin,
      key: operation.key,
      source: owner ? "owner" : admin ? "admin" : "protected",
      reason:
        owner || admin
          ? "سلطة محمية محفوظة"
          : "تخضع العملية لسلطة محمية خارج التفويض التشغيلي",
    };
  }
  const policy = effectivePolicy(user);
  const source: OperationDecisionSource =
    user.operationPolicy && own(user.operationPolicy.grants, operation.key)
      ? "user"
      : user.roleOperationPolicy
        ? "role"
        : hasOperationPolicy(user)
          ? "policy"
          : "legacy";
  let allowed = createMongoAbility(
    policy.grants[operation.key] === true
      ? [{ action: "execute", subject: operation.key }]
      : [],
  ).can("execute", operation.key);
  const hiddenCost = hasOperationPolicy(user) && operation.requiresCostVisibility === true &&
    (policy.dataVisibility?.purchaseCost !== true || policy.dataVisibility?.profitMargin !== true);
  if (hiddenCost) allowed = false;
  return {
    allowed,
    key: operation.key,
    source,
    reason: hiddenCost ? "هذه العملية تتطلب تفويض عرض التكلفة والربح" : allowed ? "العملية مفوضة لحسابك" : "العملية غير مفوضة لحسابك",
    ...(operation.supportsRecordScope === true
      ? { scope: policy.recordScopes?.[operation.key] ?? "OWN" }
      : {}),
  };
}

/** Atomic aliases only carry revocations forward; they never grant another path. */
export function applyLegacyOperationDenials(
  policy: OperationPolicy,
  explicitAtomicGrants?: Record<string, boolean> | null,
  aliasMap?: Readonly<Record<string, readonly string[]>>,
): OperationPolicy {
  const grants = { ...policy.grants };
  if (explicitAtomicGrants) {
    for (const operation of OPERATION_PERMISSIONS) {
      if (!operation.delegable) continue;
      const aliases = [
        ...operation.legacyAliases,
        ...(aliasMap?.[operation.key] ?? []),
      ];
      if (
        aliases.some(
          (key) =>
            own(explicitAtomicGrants, key) &&
            explicitAtomicGrants[key] === false,
        )
      ) {
        grants[operation.key] = false;
      }
    }
  }
  return {
    ...policy,
    grants,
    recordScopes: policy.recordScopes ? { ...policy.recordScopes } : undefined,
    dataVisibility: policy.dataVisibility
      ? { ...policy.dataVisibility }
      : undefined,
  };
}

export function buildOperationPolicyFromLegacy(
  role: string,
  modules: PermissionMap,
  explicitAtomicGrants?: Record<string, boolean> | null,
  explicitModuleOverride?: PermissionMap | null,
): OperationPolicy {
  const basePolicy = legacyOperationPolicy(role, modules, explicitModuleOverride);
  if (explicitModuleOverride != null) {
    return applyLegacyIndividualOperationOverrides(
      basePolicy,
      role,
      resolvePermissions(role as RoleKey, null),
      explicitModuleOverride,
      explicitAtomicGrants,
    );
  }
  return applyLegacyOperationDenials(
    basePolicy,
    explicitAtomicGrants,
  );
}

/** Navigation summary only. It must never be used to authorize an operation. */
export function summarizeOperationModules(
  policy: OperationPolicy,
): PermissionMap {
  const summary: PermissionMap = Object.fromEntries(
    ALL_PERMISSION_MODULE_KEYS.map((key) => [key, "NONE"]),
  );
  for (const operation of OPERATION_PERMISSIONS) {
    if (
      !operation.delegable ||
      policy.grants[operation.key] !== true ||
      !(operation.navigationModule ?? operation.module)
    )
      continue;
    // A lookup with alternative legacy gates must not reopen every alternative module.
    const modules = (operation.navigationModule ?? operation.module)!.split("|");
    if (modules.length !== 1 || !own(summary, modules[0]!)) continue;
    const moduleKey = modules[0]!;
    if (operation.kind === "mutation") summary[moduleKey] = "FULL";
    else if (summary[moduleKey] === "NONE") summary[moduleKey] = "READ";
  }
  return summary;
}

export function operationRecordScope(
  user: OperationUser,
  path: string,
): OperationRecordScope {
  const operation = getOperationPermission(path);
  return operation
    ? (effectivePolicy(user).recordScopes?.[operation.key] ?? "OWN")
    : "OWN";
}

export function canViewOperationData(
  user: OperationUser,
  field: OperationDataField,
): boolean {
  if (user.isOwner === true) return true;
  return effectivePolicy(user).dataVisibility?.[field] === true;
}

/** Selling stations depend on their own execution path, not another action in the same module. */
export const OPERATION_STATION_PATHS: Readonly<Record<PosStation, string>> = Object.freeze({
  RETAIL: "sales.create",
  PRINT_SERVICES: "printPos.createSale",
  RECEPTION: "workOrders.receptionCheckout",
});

/** Display the same decisions as execution; preserve the legacy and protected owner branches. */
export function deriveOperationAccess(user: OperationUser): EffectiveAccessSummary {
  if (user.isOwner === true)
    return deriveEffectiveAccess("admin", null);
  if (!hasOperationPolicy(user))
    return {
      ...deriveEffectiveAccess(user.role, user.permissionsOverride as PermissionMap | null),
      canSeeCost: canViewOperationData(user, "purchaseCost") && canViewOperationData(user, "profitMargin"),
    };
  const policy = effectivePolicy(user);
  const current = { ...user, resolvedOperationPolicy: policy };
  const canSeeCost = canViewOperationData(current, "purchaseCost") &&
    canViewOperationData(current, "profitMargin");
  const grants = { ...policy.grants };
  if (!canSeeCost) for (const operation of OPERATION_PERMISSIONS)
    if (operation.requiresCostVisibility) grants[operation.key] = false;
  const stations = (Object.keys(OPERATION_STATION_PATHS) as PosStation[])
    .filter(station => operationDecision(current, OPERATION_STATION_PATHS[station]).allowed);
  return {
    resolved: summarizeOperationModules({ ...policy, grants }),
    station: stations.length === 0 ? "NONE" : stations.length === 1 ? stations[0]! : "MULTI",
    stations,
    canSeeCost,
  };
}
