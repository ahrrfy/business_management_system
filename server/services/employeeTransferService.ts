import { and, desc, eq, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { branches, employeeTransfers, employees, users } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { withTx, type Actor, type MaybeScopedActor } from "./tx";
import { baghdadToday } from "./businessDay";

function requireDb() {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not set");
  return db;
}

export type TransferStatus = "PENDING" | "APPROVED" | "EFFECTIVE" | "CANCELLED";

export interface RequestTransferInput {
  employeeId: number;
  toBranchId?: number | null;
  toDepartment?: string | null;
  toPosition?: string | null;
  decisionNumber: string;
  transferDate: string;
  effectiveDate: string;
  reason?: string | null;
  notes?: string | null;
}

/** طلب نقل إداري أو فرعي لموظف. */
export async function requestEmployeeTransfer(
  actor: MaybeScopedActor,
  input: RequestTransferInput,
) {
  return withTx(async (tx) => {
    const [emp] = await tx
      .select({
        id: employees.id,
        branchId: employees.branchId,
        department: employees.department,
        position: employees.position,
      })
      .from(employees)
      .where(eq(employees.id, input.employeeId))
      .limit(1);

    if (!emp) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل أمر النقل",
          why: "الموظف المطلوب غير مسجّل في قاعدة البيانات",
          doThis: "تحقّق من معرّف الموظف وأعد المحاولة",
        }),
      });
    }

    if (input.toBranchId) {
      const [br] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, input.toBranchId))
        .limit(1);
      if (!br) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تسجيل أمر النقل",
            why: "الفرع المنقول إليه غير مسجّل في دليل الفروع",
            doThis: "اختر فرعاً صحيحاً ومفعلاً من القائمة",
          }),
        });
      }
    }

    const [res] = await tx.insert(employeeTransfers).values({
      employeeId: input.employeeId,
      fromBranchId: emp.branchId,
      toBranchId: input.toBranchId ?? emp.branchId,
      fromDepartment: emp.department,
      toDepartment: input.toDepartment?.trim() || emp.department,
      fromPosition: emp.position,
      toPosition: input.toPosition?.trim() || emp.position,
      decisionNumber: input.decisionNumber.trim(),
      transferDate: input.transferDate,
      effectiveDate: input.effectiveDate,
      reason: input.reason?.trim() || null,
      notes: input.notes?.trim() || null,
      status: "PENDING",
      createdById: actor.userId,
    });

    return { id: res.insertId, status: "PENDING" };
  });
}

/** اعتماد أمر النقل الإداري وتطبيقه على الموظف (Maker-Checker). */
export async function approveEmployeeTransfer(
  actor: MaybeScopedActor,
  id: number,
) {
  return withTx(async (tx) => {
    const [tr] = await tx
      .select()
      .from(employeeTransfers)
      .where(eq(employeeTransfers.id, id))
      .limit(1);

    if (!tr) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر اعتماد أمر النقل",
          why: "أمر النقل المطلوب غير موجود في سجلات النظام",
          doThis: "تحقّق من رقم القرار من القائمة وأعد المحاولة",
        }),
      });
    }

    if (tr.status !== "PENDING") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن اعتماد أمر النقل",
          why: `حالة أمر النقل الحالية هي (${tr.status}) وليست معلقة`,
          doThis: "يمكن اعتماد أوامر النقل المعلقة (PENDING) فقط",
        }),
      });
    }

    if (tr.createdById === actor.userId && actor.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "غير مصرّح باعتماد أمر النقل",
          why: "مبدأ فصل المهام (Maker-Checker): لا يجوز لمنشئ أمر النقل اعتماده بنفسه",
          doThis: "اطلب من مدير آخر أو الإدارة العليا مراجعة واعتماد القرار",
        }),
      });
    }

    const today = baghdadToday();
    const isEffectiveNow = tr.effectiveDate <= today;
    const finalStatus: TransferStatus = isEffectiveNow ? "EFFECTIVE" : "APPROVED";

    await tx
      .update(employeeTransfers)
      .set({
        status: finalStatus,
        approvedById: actor.userId,
        approvedAt: sql`NOW()`,
      })
      .where(eq(employeeTransfers.id, id));

    // إذا كان تاريخ السريان نافذاً اليوم، نحدّث بطاقة الموظف وحساب المستخدم فوراً
    if (isEffectiveNow) {
      await executeTransferInTx(tx, tr);
    }

    return { id, status: finalStatus };
  });
}

/**
 * تطبيق أمر النقل على الموظف والمستخدم المرتبط به ذرياً داخل المعاملة.
 * GAP-09: تحديث employees (branchId, department, position) و users.branchId معاً
 */
export async function executeTransferInTx(
  tx: Tx,
  transfer: {
    id: number;
    employeeId: number;
    toBranchId?: number | null;
    toDepartment?: string | null;
    toPosition?: string | null;
  },
) {
  const [emp] = await tx
    .select({ id: employees.id, userId: employees.userId })
    .from(employees)
    .where(eq(employees.id, transfer.employeeId))
    .for("update")
    .limit(1);

  if (emp) {
    await tx
      .update(employees)
      .set({
        branchId: transfer.toBranchId,
        department: transfer.toDepartment,
        position: transfer.toPosition,
      })
      .where(eq(employees.id, transfer.employeeId));

    if (emp.userId && transfer.toBranchId) {
      await tx
        .update(users)
        .set({
          branchId: transfer.toBranchId,
        })
        .where(eq(users.id, emp.userId));
    }
  }

  await tx
    .update(employeeTransfers)
    .set({
      status: "EFFECTIVE",
    })
    .where(eq(employeeTransfers.id, transfer.id));
}

/**
 * تنفيذ جميع أوامر النقل المعتمدة المستحقة (effectiveDate <= today).
 * GAP-08: أوامر النقل المستقبلية المعتمدة (APPROVED) تُنفّذ عند حلول تاريخ السريان.
 */
export async function executePendingTransfers(actor?: MaybeScopedActor) {
  return withTx(async (tx) => {
    const today = baghdadToday();
    const pendingApproved = await tx
      .select()
      .from(employeeTransfers)
      .where(
        and(
          eq(employeeTransfers.status, "APPROVED"),
          sql`${employeeTransfers.effectiveDate} <= ${today}`,
        ),
      )
      .for("update");

    let executedCount = 0;
    for (const tr of pendingApproved) {
      await executeTransferInTx(tx, tr);
      executedCount++;
    }

    return {
      success: true,
      executedCount,
      transferIds: pendingApproved.map((t) => t.id),
    };
  });
}

/** استعلام تنقلات الموظف مع دعم عزل الفروع. */
export async function listEmployeeTransfers(
  employeeId: number,
  scopedBranchId?: number | null,
) {
  const db = requireDb();
  const conds = [eq(employeeTransfers.employeeId, employeeId)];
  if (scopedBranchId != null) {
    conds.push(
      or(
        eq(employeeTransfers.fromBranchId, scopedBranchId),
        eq(employeeTransfers.toBranchId, scopedBranchId),
      )!,
    );
  }
  return db
    .select()
    .from(employeeTransfers)
    .where(and(...conds))
    .orderBy(desc(employeeTransfers.effectiveDate));
}
