import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  hasOperationPolicy,
  buildOperationPolicyFromLegacy,
  getOperationPermission,
  operationDecision,
  operationPolicySchema,
  resolveOperationPolicy,
  type OperationPolicy,
  type OperationUser,
} from "@shared/operationPermissions";
import {
  applyPermissionOverrides,
  diffFromTemplate,
  resolvePermissions,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { appErrorMessage } from "@shared/errors";
import { roles, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";

const serviceOperationMarker = Symbol("guarded-service-operation");

/** Server-only proof: never accepted as RPC input and bound to one actor/path. */
export interface ServiceOperationAuthority {
  readonly [serviceOperationMarker]: true;
  readonly userId: number;
  readonly path: string;
}

export interface ServiceOperationActor {
  userId: number;
  role?: string;
  operationAuthority?: ServiceOperationAuthority;
}

export function routeOperationAuthority(
  user: OperationUser & { id: number },
  path: string,
): ServiceOperationAuthority | undefined {
  if (!hasOperationPolicy(user)) return undefined;
  if (getOperationPermission(path)?.delegable !== true) return undefined;
  if (!operationDecision(user, path).allowed) throw forbiddenOperation();
  return Object.freeze({ [serviceOperationMarker]: true as const, userId: user.id, path });
}

export function hasServiceOperationAuthority(
  authority: ServiceOperationAuthority | undefined,
  userId: number,
  path: string,
): boolean {
  return authority?.[serviceOperationMarker] === true && authority.userId === userId && authority.path === path;
}

interface StoredUser {
  id: number;
  role: string;
  isActive: boolean | null;
  isOwner: boolean;
  customRoleId: number | null;
  permissionsOverride: unknown;
  atomicPermissions?: unknown;
  operationPolicy: unknown;
  accessExpiresAt?: Date | null;
  branchId?: number | null;
}
interface StoredRole {
  baseRole: string;
  isActive: boolean;
  permissions: unknown;
  operationPolicy: unknown;
  atomicPermissions?: unknown;
}

function forbiddenOperation(): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
    what: "تعذّر تنفيذ العملية",
    why: "الصلاحية التشغيلية الحالية لا تسمح بهذا الإجراء",
    doThis: "حدّث الصفحة وراجع الإدارة لتحديد صلاحية العملية لحسابك",
  }) });
}

function storedPolicy(value: unknown): OperationPolicy | null {
  if (value == null) return null;
  const parsed = operationPolicySchema.safeParse(value);
  if (!parsed.success) throw forbiddenOperation();
  return parsed.data;
}

/** Same role/user precedence as request context; callers supply locked DB rows. */
export type StoredOperationSnapshot = OperationUser & { branchId?: number | null };

export function storedOperationUser(user: StoredUser, role?: StoredRole | null): StoredOperationSnapshot {
  if (!user.isActive || (user.accessExpiresAt != null && user.accessExpiresAt.getTime() <= Date.now())) throw forbiddenOperation();
  if (user.isOwner) return { role: "admin", isOwner: true, branchId: user.branchId };
  if (user.customRoleId != null && !role?.isActive) {
    return { role: "user", branchId: user.branchId, operationPolicyEnabled: true, resolvedOperationPolicy: { version: 1, grants: {} } };
  }
  const effectiveRole = (role?.baseRole ?? user.role) as RoleKey;
  const roleModules = role
    ? resolvePermissions(effectiveRole, diffFromTemplate(effectiveRole, role.permissions as PermissionMap))
    : resolvePermissions(effectiveRole, null);
  const modules = applyPermissionOverrides(roleModules, user.permissionsOverride as PermissionMap | null);
  const override = diffFromTemplate(effectiveRole, modules);
  const rolePolicy = storedPolicy(role?.operationPolicy);
  const userPolicy = storedPolicy(user.operationPolicy);
  const inheritedPolicy = rolePolicy ?? buildOperationPolicyFromLegacy(
    effectiveRole, roleModules, role?.atomicPermissions as Record<string, boolean> | null | undefined,
    diffFromTemplate(effectiveRole, roleModules),
  );
  return {
    role: effectiveRole,
    branchId: user.branchId,
    permissionsOverride: override,
    resolvedPermissions: modules,
    roleOperationPolicy: rolePolicy,
    operationPolicy: userPolicy,
    operationPolicyEnabled: Boolean(rolePolicy || userPolicy),
    resolvedOperationPolicy: resolveOperationPolicy(effectiveRole, modules, inheritedPolicy, userPolicy, override, {
      permissionsOverride: user.permissionsOverride as PermissionMap | null,
      atomicPermissions: user.atomicPermissions as Record<string, boolean> | null | undefined,
    }),
  };
}

/** Lock order agrees with updateRole: role before user. Assignment drift retries safely. */
export async function loadOperationUserTx(tx: Tx, userId: number): Promise<StoredOperationSnapshot> {
  const [probe] = await tx.select({ customRoleId: users.customRoleId }).from(users).where(eq(users.id, userId)).limit(1);
  const role = probe?.customRoleId == null ? null : (await tx.select().from(roles)
    .where(eq(roles.id, probe.customRoleId)).for("share").limit(1))[0];
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("share").limit(1);
  if (!user) throw forbiddenOperation();
  if (user.customRoleId !== probe?.customRoleId) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تغيّر إسناد الدور أثناء العملية",
      why: "الإدارة حدّثت دور الحساب قبل تثبيت الصلاحية الحالية",
      doThis: "حدّث الصفحة وأعد المحاولة بصلاحيات الدور الجديد",
    }) });
  }
  return storedOperationUser(user, role);
}

export function canonicalOperationAllowed(user: OperationUser, path: string): boolean | undefined {
  return hasOperationPolicy(user) ? operationDecision(user, path).allowed : undefined;
}

/** Re-read before the write; a router proof cannot survive an intervening revocation. */
export async function assertOperationAuthorityTx(
  tx: Tx,
  actor: { userId: number; role?: string; branchId?: number | null },
  path: string,
  legacyAllowed: boolean,
  authority?: ServiceOperationAuthority,
): Promise<boolean> {
  if (authority && !hasServiceOperationAuthority(authority, actor.userId, path)) throw forbiddenOperation();
  const current = await loadOperationUserTx(tx, actor.userId);
  if ((current.isOwner !== true && actor.role != null && actor.role !== current.role) || (
    current.role !== "admin" && actor.branchId != null && current.branchId !== undefined &&
    Number(actor.branchId) !== Number(current.branchId)
  )) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
      what: "تغيّر إسناد الحساب أثناء العملية",
      why: "الدور أو الفرع الحالي يختلف عن بيانات الطلب المفتوح",
      doThis: "حدّث الصفحة وأعد المحاولة بالدور والفرع الحاليين",
    }) });
  }
  const canonical = canonicalOperationAllowed(current, path);
  if (!(canonical ?? legacyAllowed)) throw forbiddenOperation();
  return canonical === true;
}

/** A nested financial step may continue only its explicitly accepted, guarded parent action. */
export async function assertServiceOperationTx(
  tx: Tx,
  actor: ServiceOperationActor,
  path: string,
  acceptedParentPaths: readonly string[] = [],
): Promise<boolean> {
  const parent = acceptedParentPaths.find((candidate) =>
    hasServiceOperationAuthority(actor.operationAuthority, actor.userId, candidate));
  return assertOperationAuthorityTx(
    tx, actor, parent ?? path,
    actor.role === "admin" || actor.role === "manager", actor.operationAuthority,
  );
}
