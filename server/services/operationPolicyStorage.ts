import {
  operationPolicySchema,
  type OperationPolicy,
} from "@shared/operationPermissions";
import { appErrorMessage } from "@shared/errors";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { roles, users } from "../../drizzle/schema";
import type { Tx } from "../db";
import { validateUserForSession } from "../auth/session";
import type { MaybeScopedActor } from "./tx";
import { logAuditTx, type AuditMetadata } from "./auditService";

/** Identity writes cannot trust the authority captured when the HTTP request began. */
export async function lockIdentityAdministrationTx(
  tx: Tx,
  actor: MaybeScopedActor,
  options: {
    roleIds?: number[];
    userIds?: number[];
    affectedRoleId?: number;
    includeActiveAdmins?: boolean;
  } = {},
) {
  const userIds = Array.from(
    new Set([actor.userId, ...(options.userIds ?? [])]),
  );
  const userConditions = [inArray(users.id, userIds)];
  if (options.affectedRoleId != null)
    userConditions.push(eq(users.customRoleId, options.affectedRoleId));
  if (options.includeActiveAdmins)
    userConditions.push(
      and(eq(users.role, "admin"), eq(users.isActive, true))!,
    );
  // This read discovers dependencies only. Authority comes from the locked rows below.
  const discovered = await tx
    .select({ customRoleId: users.customRoleId })
    .from(users)
    .where(or(...userConditions));
  const roleIds = Array.from(
    new Set([
      ...(options.roleIds ?? []),
      ...discovered.flatMap((row) =>
        row.customRoleId == null ? [] : [row.customRoleId],
      ),
    ]),
  ).sort((a, b) => a - b);
  // Exclusive from the outset: self-editing must never upgrade a shared actor lock.
  // The primary index fixes scan order even when MySQL would prefer another index.
  const lockedRoles =
    roleIds.length === 0
      ? []
      : await tx
          .select()
          .from(roles, { forceIndex: "PRIMARY" })
          .where(inArray(roles.id, roleIds))
          .orderBy(asc(roles.id))
          .for("update");
  const lockedUsers = await tx
    .select()
    .from(users, { forceIndex: "PRIMARY" })
    .where(or(...userConditions))
    .orderBy(asc(users.id))
    .for("update");
  const roleRows = new Map(lockedRoles.map((row) => [row.id, row]));
  const userRows = new Map(lockedUsers.map((row) => [row.id, row]));
  const lockedRoleIds = new Set(roleIds);
  for (const row of lockedUsers) {
    if (row.customRoleId != null && !lockedRoleIds.has(row.customRoleId)) {
      // A concurrent reassignment won before our user lock. Do not invert lock order.
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "لم تُحفظ تغييرات إدارة الهوية",
          why: "تغيّر إسناد دور أحد الحسابات أثناء الحفظ",
          doThis: "أعد تحميل الحساب أو الدور ثم أعد الحفظ",
        }),
      });
    }
  }
  const current = userRows.get(actor.userId);
  const assignedRole =
    current?.customRoleId == null ? null : roleRows.get(current.customRoleId);
  const resolvedRole =
    current?.isOwner === true
      ? "admin"
      : current?.customRoleId == null
        ? current?.role
        : assignedRole?.isActive === true
          ? assignedRole.baseRole
          : null;
  const assertAuthority = () => {
    if (!validateUserForSession(current) || resolvedRole !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر حفظ تغييرات إدارة الهوية",
          why: "حساب المنفّذ لم يعد نشطاً وصالحاً بتفويض إدارة النظام",
          doThis: "أعد تسجيل الدخول بحساب مدير نظام أو مالك مخوّل ثم أعد الحفظ",
        }),
      });
    }
  };
  assertAuthority();
  return {
    actor: {
      userId: current!.id,
      branchId: current!.branchId,
      role: "admin",
      isOwner: current!.isOwner === true,
    } satisfies MaybeScopedActor,
    roles: roleRows,
    users: userRows,
    // Row locks freeze authority changes; time-based expiry can still advance.
    assertAuthority,
  };
}

/** Validate at the service boundary as well as the transport boundary. */
export function normalizeOperationPolicy(
  input: unknown,
): OperationPolicy | null {
  if (input == null) return null;
  const result = operationPolicySchema.safeParse(input);
  if (!result.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حفظ تفويض العمليات",
        why: "توجد عملية غير معروفة أو قيمة تفويض غير صالحة",
        doThis: "أعد تحميل مصفوفة العمليات وحدّد التفويض من الخيارات المتاحة",
      }),
    });
  }
  return result.data;
}

function stableValue(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableValue(v)}`).join(",")}}`;
}

export function sameOperationPolicy(before: unknown, after: unknown): boolean {
  return stableValue(before ?? null) === stableValue(after ?? null);
}

export function assertOperationPolicyRevision(
  actual: number,
  expected: number | undefined,
): void {
  if (expected !== actual) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "لم تُحفظ تغييرات تفويض العمليات",
        why:
          expected === undefined
            ? "رقم نسخة التفويض غير موجود في الطلب"
            : "عُدّل التفويض بواسطة جلسة أخرى",
        doThis:
          "أعد تحميل الحساب أو الدور وراجع التفويض الحالي ثم احفظ اختياراتك",
      }),
    });
  }
}

export type PolicyChange = { field: string; before: unknown; after: unknown };

function policyChanges(
  before: OperationPolicy | null,
  after: OperationPolicy | null,
): PolicyChange[] {
  const changes: PolicyChange[] = [];
  if (!!before !== !!after)
    changes.push({
      field: "inheritance",
      before: before ? "explicit" : "inherited",
      after: after ? "explicit" : "inherited",
    });
  for (const section of ["grants", "recordScopes", "dataVisibility"] as const) {
    const previous = before?.[section] ?? {};
    const next = after?.[section] ?? {};
    for (const key of Array.from(
      new Set([...Object.keys(previous), ...Object.keys(next)]),
    )) {
      const oldValue = (previous as Record<string, unknown>)[key] ?? null;
      const newValue = (next as Record<string, unknown>)[key] ?? null;
      if (oldValue !== newValue)
        changes.push({
          field: `${section}.${key}`,
          before: oldValue,
          after: newValue,
        });
    }
  }
  return changes;
}

/** Every delta is retained: a whole catalogue would be truncated by audit's byte limit. */
export async function auditOperationPolicyTx(
  tx: Tx,
  actor: AuditMetadata,
  entityType: "role" | "user",
  entityId: number,
  before: OperationPolicy | null,
  after: OperationPolicy | null,
  previousRevision: number,
  revision: number,
  extraChanges: PolicyChange[] = [],
): Promise<void> {
  const changes = [...policyChanges(before, after), ...extraChanges];
  const batches: PolicyChange[][] = [[]];
  for (const change of changes) {
    const batch = batches[batches.length - 1];
    if (Buffer.byteLength(JSON.stringify([...batch, change]), "utf8") > 5500)
      batches.push([change]);
    else batch.push(change);
  }
  for (let part = 0; part < batches.length; part++) {
    const changes = batches[part];
    await logAuditTx(tx, actor, {
      action: `${entityType}.operationPolicy`,
      entityType,
      entityId,
      oldValue: { operationPolicyRevision: previousRevision },
      newValue: {
        operationPolicyRevision: revision,
        part: part + 1,
        parts: batches.length,
        changes,
      },
    });
  }
}
