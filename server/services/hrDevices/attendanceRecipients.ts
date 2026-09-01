import { and, eq, inArray, or } from "drizzle-orm";
import { roles, users } from "../../../drizzle/schema";
import {
  applyPermissionOverrides,
  diffFromTemplate,
  levelSatisfies,
  resolvePermissions,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { requireDb } from "../tx";

export interface AttendanceSupervisorCandidate {
  id: number;
  role: RoleKey;
  branchId: number | null;
  isOwner: boolean;
  isActive: boolean | null;
  accessExpiresAt: Date | null;
  permissionsOverride: PermissionMap | null;
  customRoleId: number | null;
  customRoleBaseRole: RoleKey | null;
  customRolePermissions: PermissionMap | null;
}

function effectiveAuthority(
  candidate: AttendanceSupervisorCandidate,
): { role: RoleKey; permissions: PermissionMap } | null {
  if (candidate.isOwner) {
    return { role: "admin", permissions: resolvePermissions("admin", null) };
  }
  if (candidate.customRoleId != null) {
    // يطابق فشل context المغلق: دور مخصّص معطّل/محذوف لا يستعيد baseRole المخزّن.
    if (!candidate.customRoleBaseRole || !candidate.customRolePermissions) {
      return null;
    }
    const baseRole = candidate.customRoleBaseRole;
    const customPermissions = resolvePermissions(
      baseRole,
      diffFromTemplate(baseRole, candidate.customRolePermissions),
    );
    return {
      role: baseRole,
      permissions: applyPermissionOverrides(
        customPermissions,
        candidate.permissionsOverride,
      ),
    };
  }
  return {
    role: candidate.role,
    permissions: resolvePermissions(
      candidate.role,
      candidate.permissionsOverride,
    ),
  };
}

/** اختيار حتميّ قابل للاختبار؛ قاعدة البيانات تجلب المرشّحين فقط ولا تقرّر التفويض. */
export function selectAttendanceSupervisorRecipientIds(
  candidates: AttendanceSupervisorCandidate[],
  input: {
    employeeUserId: number | null;
    branchId: number | null;
    now?: Date;
  },
): number[] {
  const now = input.now ?? new Date();
  const recipients = new Set<number>();
  for (const candidate of candidates) {
    if (candidate.id === input.employeeUserId || candidate.isActive !== true) {
      continue;
    }
    if (
      candidate.accessExpiresAt &&
      candidate.accessExpiresAt.getTime() <= now.getTime()
    ) {
      continue;
    }
    const authority = effectiveAuthority(candidate);
    if (!authority) continue;
    const crossesBranches = candidate.isOwner || authority.role === "admin";
    if (
      !crossesBranches &&
      (input.branchId == null || candidate.branchId !== input.branchId)
    ) {
      continue;
    }
    if (
      authority.role !== "admin" &&
      !levelSatisfies(authority.permissions.hr, "FULL")
    ) {
      continue;
    }
    recipients.add(candidate.id);
  }
  return Array.from(recipients).sort((a, b) => a - b);
}

/** مديرو الموارد البشرية الفعّالون: الإدارة تعبر الفروع، ومدير الفرع يبقى في فرعه. */
export async function listAttendanceSupervisorRecipientIds(input: {
  employeeUserId: number | null;
  branchId: number | null;
}): Promise<number[]> {
  const rows = await requireDb()
    .select({
      id: users.id,
      role: users.role,
      branchId: users.branchId,
      isOwner: users.isOwner,
      isActive: users.isActive,
      accessExpiresAt: users.accessExpiresAt,
      permissionsOverride: users.permissionsOverride,
      customRoleId: users.customRoleId,
      customRoleBaseRole: roles.baseRole,
      customRolePermissions: roles.permissions,
    })
    .from(users)
    .leftJoin(
      roles,
      and(eq(users.customRoleId, roles.id), eq(roles.isActive, true)),
    )
    .where(
      or(inArray(users.role, ["admin", "manager"]), eq(users.isOwner, true)),
    );

  return selectAttendanceSupervisorRecipientIds(
    rows.map((row) => ({
      id: Number(row.id),
      role: row.role as RoleKey,
      branchId: row.branchId == null ? null : Number(row.branchId),
      isOwner: row.isOwner === true,
      isActive: row.isActive,
      accessExpiresAt: row.accessExpiresAt,
      permissionsOverride: row.permissionsOverride as PermissionMap | null,
      customRoleId: row.customRoleId == null ? null : Number(row.customRoleId),
      customRoleBaseRole: row.customRoleBaseRole as RoleKey | null,
      customRolePermissions: row.customRolePermissions as PermissionMap | null,
    })),
    input,
  );
}
