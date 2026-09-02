import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { branches, customers, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import type { Actor } from "../tx";

export function isPipelineSupervisor(actor: Actor): boolean {
  return (
    actor.role === "admin" || actor.role === "manager" || actor.isOwner === true
  );
}

export function canPipelineCrossBranches(actor: Actor): boolean {
  return actor.role === "admin" || actor.isOwner === true;
}

export function resolvePipelineBranch(
  requestedBranchId: number | null | undefined,
  actor: Actor,
): number {
  if (canPipelineCrossBranches(actor)) {
    const branchId = requestedBranchId ?? actor.branchId;
    if (!Number.isInteger(branchId) || Number(branchId) <= 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "اختر الفرع التشغيلي للسجل",
      });
    }
    return Number(branchId);
  }
  if (!Number.isInteger(actor.branchId) || actor.branchId <= 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا فرع مُسنَد لهذا المستخدم",
    });
  }
  if (
    requestedBranchId != null &&
    Number(requestedBranchId) !== actor.branchId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا تستطيع إدارة مسار مبيعات لفرع آخر",
    });
  }
  return actor.branchId;
}

export function assertPipelineRowWritable(
  row: { branchId: number | string; ownerId: number | string },
  actor: Actor,
): void {
  if (
    !canPipelineCrossBranches(actor) &&
    Number(row.branchId) !== actor.branchId
  ) {
    throw new TRPCError({ code: "NOT_FOUND", message: "السجل غير موجود" });
  }
  if (!isPipelineSupervisor(actor) && Number(row.ownerId) !== actor.userId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "السجل غير موجود" });
  }
}

export async function assertActiveBranchTx(
  tx: Tx,
  branchId: number,
): Promise<void> {
  const [branch] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.isActive, true)))
    .limit(1);
  if (!branch)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "الفرع غير موجود أو غير فعّال",
    });
}

export async function resolvePipelineOwnerTx(
  tx: Tx,
  requestedOwnerId: number | null | undefined,
  branchId: number,
  actor: Actor,
): Promise<number> {
  const ownerId = requestedOwnerId ?? actor.userId;
  if (!isPipelineSupervisor(actor) && ownerId !== actor.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "الموظف يدير مساره المسند إليه فقط",
    });
  }
  const [owner] = await tx
    .select({
      id: users.id,
      branchId: users.branchId,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (
    !owner ||
    owner.isActive === false ||
    Number(owner.branchId ?? 0) !== branchId
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مالك المتابعة يجب أن يكون مستخدماً فعّالاً في الفرع نفسه",
    });
  }
  return ownerId;
}

export async function assertCustomerTx(
  tx: Tx,
  customerId: number | null | undefined,
): Promise<void> {
  if (customerId == null) return;
  const [customer] = await tx
    .select({ id: customers.id, isActive: customers.isActive })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customer || customer.isActive === false) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "العميل المرتبط غير موجود أو معطّل",
    });
  }
}
