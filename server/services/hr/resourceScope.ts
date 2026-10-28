import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { hasModuleAccess } from "@shared/permissions";
import { employees } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { canCrossBranches } from "../../lib/branchAuthority";
import {
  loadOperationUserTx,
  storedCanonicalOperationAllowed,
} from "../authorization/operationAuthority";
import type { MaybeScopedActor } from "../tx";

/** Reuse the canonical locked role/user snapshot; request claims never grant HR authority. */
export async function resolveHrActorTx(
  tx: Tx,
  actor: Pick<MaybeScopedActor, "userId">,
  path: string,
): Promise<MaybeScopedActor> {
  const current = await loadOperationUserTx(tx, actor.userId);
  const allowed =
    storedCanonicalOperationAllowed(current, path) ??
    hasModuleAccess(
      current.role ?? "user",
      current.persistedPermissionsOverride,
      "hr",
      "FULL",
    );
  if (!allowed)
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تنفيذ إجراء الموارد البشرية",
        why: "الصلاحية الحالية للحساب لا تسمح بهذا الإجراء",
        doThis: "حدّث الصفحة وراجع الإدارة للتحقق من صلاحيات الحساب",
      }),
    });
  return {
    userId: actor.userId,
    role: current.role ?? undefined,
    isOwner: current.isOwner === true,
    branchId: current.branchId ?? null,
  };
}

export function assertHrBranch(
  actor: MaybeScopedActor,
  branchId: number | null | undefined,
): void {
  if (canCrossBranches(actor)) return;
  if (
    actor.branchId == null ||
    branchId == null ||
    actor.branchId !== branchId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "غير مصرّح بتعديل سجل الموارد البشرية",
        why: "الموظف أو المستند يتبع فرعاً آخر خارج نطاق صلاحيتك",
        doThis: "اختر موظفاً ومستنداً من فرعك أو راجع الإدارة المركزية",
      }),
    });
  }
}

/** Lock the actual employee, and validate both live ownership and the document's recorded scope. */
export async function lockHrEmployeeTx(
  tx: Tx,
  actor: MaybeScopedActor,
  employeeId: number,
  recordedBranchId?: number | null,
) {
  const [employee] = await tx
    .select()
    .from(employees)
    .where(eq(employees.id, employeeId))
    .for("update")
    .limit(1);
  if (!employee)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر تنفيذ إجراء الموظف",
        why: "الموظف المطلوب غير موجود في سجلات النظام",
        doThis: "تحقّق من معرّف الموظف وأعد المحاولة",
      }),
    });
  assertHrBranch(actor, employee.branchId);
  if (recordedBranchId !== undefined) assertHrBranch(actor, recordedBranchId);
  return employee;
}
