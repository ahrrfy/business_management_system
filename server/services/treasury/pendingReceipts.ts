import { TRPCError } from "@trpc/server";
import { and, asc, eq, or, like } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { receipts, shifts, users } from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { logAuditTx } from "../auditService";
import { requireDb, withTx, type Actor } from "../tx";

export interface PendingTreasuryReceipt {
  id: number;
  branchId: number;
  amount: string;
  referenceNumber: string;
  description: string | null;
  createdAt: Date;
  source: "CASH_DROP" | "CASH_HANDOVER";
  /** مالك الدرج الذي خرج منه النقد، لا الموظف المعيّن لاستلامه. */
  sourceEmployeeName: string | null;
  sourceShiftId: number | null;
}

type AuditContext = Pick<TrpcContext, "user" | "req">;

function contractSource(referenceNumber: string): PendingTreasuryReceipt["source"] | null {
  if (referenceNumber.startsWith("CD-")) return "CASH_DROP";
  if (referenceNumber.startsWith("CH-")) return "CASH_HANDOVER";
  return null;
}

/**
 * عهد الاستلام المسندة للمستخدم الحالي فقط. لا تعرض أي سند PENDING عام:
 * المرجع CD/CH + نقد وارد للخزينة + createdBy هو عقد الحيازة.
 */
export async function listMyPendingTreasuryReceipts(actor: Actor): Promise<PendingTreasuryReceipt[]> {
  // السند الوارد المعلّق يحمل createdBy للمستلم. أمّا مصدر النقد الحقيقي فهو
  // السند الصادر المقابل (DRAWER) ثمّ صاحب الوردية المرتبطة به.
  const sourceReceipt = alias(receipts, "pendingTreasurySourceReceipt");
  const sourceEmployee = alias(users, "pendingTreasurySourceEmployee");
  const rows = await requireDb()
    .select({
      id: receipts.id,
      branchId: receipts.branchId,
      amount: receipts.amount,
      referenceNumber: receipts.referenceNumber,
      description: receipts.description,
      createdAt: receipts.createdAt,
      sourceShiftId: sourceReceipt.shiftId,
      sourceEmployeeName: sourceEmployee.name,
    })
    .from(receipts)
    .leftJoin(
      sourceReceipt,
      and(
        eq(sourceReceipt.referenceNumber, receipts.referenceNumber),
        eq(sourceReceipt.branchId, receipts.branchId),
        eq(sourceReceipt.direction, "OUT"),
        eq(sourceReceipt.paymentMethod, "CASH"),
        eq(sourceReceipt.cashBucket, "DRAWER"),
      ),
    )
    .leftJoin(shifts, eq(sourceReceipt.shiftId, shifts.id))
    .leftJoin(sourceEmployee, eq(shifts.userId, sourceEmployee.id))
    .where(
      and(
        eq(receipts.createdBy, actor.userId),
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "TREASURY"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "APPROVED"),
        or(like(receipts.referenceNumber, "CD-%"), like(receipts.referenceNumber, "CH-%")),
      ),
    )
    .orderBy(asc(receipts.createdAt));

  return rows.flatMap((row) => {
    if (row.branchId == null || row.referenceNumber == null) return [];
    const source = contractSource(row.referenceNumber);
    if (!source) return [];
    return [{
      id: Number(row.id),
      branchId: Number(row.branchId),
      amount: String(row.amount),
      referenceNumber: row.referenceNumber,
      description: row.description,
      createdAt: row.createdAt,
      source,
      sourceEmployeeName: row.sourceEmployeeName,
      sourceShiftId: row.sourceShiftId == null ? null : Number(row.sourceShiftId),
    }];
  });
}

/**
 * قبول ثنائي للحيازة. يقفل الصف لمنع قبولين متزامنين، ويقبل فقط المستلم
 * المسند إليه العقد ومن فرعه. إعادة الطلب بعد النجاح آمنة ولا تضاعف الرصيد.
 */
export async function acceptPendingTreasuryReceipt(
  receiptId: number,
  actor: Actor,
  auditCtx?: AuditContext,
) {
  return withTx(async (tx) => {
    const row = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "عهدة الاستلام غير موجودة" });
    }

    const referenceNumber = row.referenceNumber ?? "";
    const source = contractSource(referenceNumber);
    const isTreasuryContract =
      source != null &&
      row.direction === "IN" &&
      row.paymentMethod === "CASH" &&
      row.cashBucket === "TREASURY" &&
      row.approvalStatus === "APPROVED";
    if (!isTreasuryContract) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ليس عقد تسليم نقد معلقاً" });
    }
    if (row.createdBy == null || Number(row.createdBy) !== actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذه العهدة مسندة إلى مستلم آخر" });
    }
    if (row.branchId == null || Number(row.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذه العهدة لا تخص فرعك" });
    }

    if (row.status === "COMPLETED") {
      return {
        receiptId: Number(row.id),
        referenceNumber,
        amount: String(row.amount),
        branchId: Number(row.branchId),
        idempotent: true,
      };
    }
    if (row.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: "عهدة الاستلام ليست قابلة للقبول" });
    }

    await tx
      .update(receipts)
      .set({
        status: "COMPLETED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
      })
      .where(and(eq(receipts.id, receiptId), eq(receipts.status, "PENDING")));

    if (auditCtx) {
      await logAuditTx(tx, auditCtx, {
        action: "treasury.handover.accept",
        entityType: "receipt",
        entityId: receiptId,
        oldValue: { status: "PENDING", referenceNumber },
        newValue: {
          status: "COMPLETED",
          referenceNumber,
          amount: String(row.amount),
          branchId: Number(row.branchId),
          source,
        },
      });
    }

    return {
      receiptId: Number(row.id),
      referenceNumber,
      amount: String(row.amount),
      branchId: Number(row.branchId),
      idempotent: false,
    };
  });
}
