import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import {
  resolveOperationalCaps,
  type OperationalCaps,
} from "@shared/atomicPermissions";
import { roles, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { eq } from "drizzle-orm";

export interface CurrentOperationalAuthority {
  branchId: number | null;
  caps: Required<OperationalCaps>;
  isOwner: boolean;
  role: string;
}

/**
 * Re-read the actor's execution limits inside the financial transaction.
 *
 * The request context is only a snapshot. Role/user caps may be lowered while
 * a request is waiting on domain locks, so money writers must not authorize a
 * refund from that stale snapshot. The shared-lock order mirrors role/user
 * administration and the direct-return path: roles -> users.
 */
export async function loadCurrentOperationalAuthorityTx(
  tx: Tx,
  userId: number,
): Promise<CurrentOperationalAuthority> {
  const [probe] = await tx
    .select({ customRoleId: users.customRoleId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  let customRole: {
    baseRole: string;
    isActive: boolean;
    key: string;
    operationalCaps: unknown;
  } | null = null;
  if (probe?.customRoleId != null) {
    const [row] = await tx
      .select({
        baseRole: roles.baseRole,
        isActive: roles.isActive,
        key: roles.key,
        operationalCaps: roles.operationalCaps,
      })
      .from(roles)
      .where(eq(roles.id, probe.customRoleId))
      .for("share")
      .limit(1);
    if (row) customRole = { ...row, isActive: Boolean(row.isActive) };
  }

  const [user] = await tx
    .select({
      branchId: users.branchId,
      accessExpiresAt: users.accessExpiresAt,
      customRoleId: users.customRoleId,
      isActive: users.isActive,
      isOwner: users.isOwner,
      operationalCaps: users.operationalCaps,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for("share")
    .limit(1);

  if (
    !user ||
    !user.isActive ||
    (user.accessExpiresAt != null && user.accessExpiresAt.getTime() <= Date.now())
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذر تثبيت تفويض العملية",
        why: user
          ? user.accessExpiresAt != null && user.accessExpiresAt.getTime() <= Date.now()
            ? "انتهت صلاحية الوصول الزمنية لحساب منفذ العملية"
            : "حساب منفذ العملية معطل حالياً"
          : "حساب منفذ العملية غير موجود في سجل المستخدمين",
        doThis: "تحقق من تفعيل الحساب وإسناد دوره لدى مسؤول النظام ثم أعد المحاولة",
      }),
    });
  }
  if (user.customRoleId !== probe?.customRoleId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر تثبيت تفويض العملية",
        why: "تغير إسناد دور الحساب أثناء تنفيذ الطلب",
        doThis: "حدث الصفحة وأعد تنفيذ العملية بصلاحيات الدور الحالية",
      }),
    });
  }

  const isOwner = Boolean(user.isOwner);
  if (isOwner) {
    return {
      branchId: user.branchId == null ? null : Number(user.branchId),
      caps: resolveOperationalCaps("admin"),
      isOwner: true,
      role: "admin",
    };
  }

  if (user.customRoleId != null) {
    // Match resolveCustomRole's fail-closed behavior for a missing/inactive role.
    if (!customRole?.isActive) {
      return {
        branchId: user.branchId == null ? null : Number(user.branchId),
        caps: resolveOperationalCaps("user"),
        isOwner: false,
        role: "user",
      };
    }
    return {
      branchId: user.branchId == null ? null : Number(user.branchId),
      caps: resolveOperationalCaps(
        customRole.key,
        customRole.operationalCaps as OperationalCaps | null,
        user.operationalCaps as OperationalCaps | null,
        customRole.baseRole,
      ),
      isOwner: false,
      role: customRole.baseRole,
    };
  }

  return {
    branchId: user.branchId == null ? null : Number(user.branchId),
    caps: resolveOperationalCaps(
      user.role,
      null,
      user.operationalCaps as OperationalCaps | null,
      user.role,
    ),
    isOwner: false,
    role: user.role,
  };
}
