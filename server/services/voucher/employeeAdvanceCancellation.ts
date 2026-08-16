import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import {
  advanceSettlements,
  employeeAdvanceRepaymentAllocations,
  employeeAdvances,
  terminationAdvanceAllocations,
  type EmployeeAdvance,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money } from "../money";

export interface EmployeeAdvanceCancellationSource {
  originalReceiptId: number;
  employeeId: number;
  branchId: number;
  expectedAmount: string;
}

export type LockedEmployeeAdvanceCancellation = EmployeeAdvance;

const USED_ADVANCE_MESSAGE =
  "لا يمكن إلغاء سند السلفة بعد استعمالها أو تسويتها كلياً أو جزئياً؛ استخدم مسار تسوية السلفة المعتمد";

/**
 * Locks the materialized advance and every append-only allocation ledger.
 * Cancellation is safe only while the grant is wholly untouched. Historical
 * APPLY/REVERSE rows still count as use: immutable history must never be
 * erased by reversing the source voucher.
 */
export async function lockUntouchedEmployeeAdvanceForCancellationTx(
  tx: Tx,
  source: EmployeeAdvanceCancellationSource,
): Promise<LockedEmployeeAdvanceCancellation> {
  const rows = await tx
    .select()
    .from(employeeAdvances)
    .where(eq(employeeAdvances.receiptId, source.originalReceiptId))
    .for("update")
    .limit(2);
  const advance = rows[0];
  if (
    rows.length !== 1 ||
    !advance ||
    advance.status !== "ACTIVE" ||
    Number(advance.employeeId) !== source.employeeId ||
    Number(advance.branchId) !== source.branchId ||
    !money(advance.amount).eq(money(source.expectedAmount))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تعذر إثبات السلفة الفعلية المطابقة لسند الصرف الأصلي",
    });
  }
  if (!money(advance.remaining).eq(money(advance.amount))) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: USED_ADVANCE_MESSAGE,
    });
  }

  // Stable lock order is shared by every voucher cancellation attempt.
  const settlement = (
    await tx
      .select({ id: advanceSettlements.id })
      .from(advanceSettlements)
      .where(eq(advanceSettlements.advanceId, Number(advance.id)))
      .for("update")
      .limit(1)
  )[0];
  const repaymentAllocation = (
    await tx
      .select({ id: employeeAdvanceRepaymentAllocations.id })
      .from(employeeAdvanceRepaymentAllocations)
      .where(
        eq(employeeAdvanceRepaymentAllocations.advanceId, Number(advance.id)),
      )
      .for("update")
      .limit(1)
  )[0];
  const terminationAllocation = (
    await tx
      .select({ id: terminationAdvanceAllocations.id })
      .from(terminationAdvanceAllocations)
      .where(eq(terminationAdvanceAllocations.advanceId, Number(advance.id)))
      .for("update")
      .limit(1)
  )[0];
  if (settlement || repaymentAllocation || terminationAllocation) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: USED_ADVANCE_MESSAGE,
    });
  }
  return advance;
}

/** Must receive the row returned by the lock helper in the same transaction. */
export async function cancelLockedEmployeeAdvanceTx(
  tx: Tx,
  advance: LockedEmployeeAdvanceCancellation,
): Promise<void> {
  const updateResult = await tx
    .update(employeeAdvances)
    .set({ status: "CANCELLED", remaining: "0.00" })
    .where(
      and(
        eq(employeeAdvances.id, Number(advance.id)),
        eq(employeeAdvances.receiptId, Number(advance.receiptId)),
        eq(employeeAdvances.status, "ACTIVE"),
        eq(employeeAdvances.remaining, String(advance.amount)),
      ),
    );
  const affectedRows = Number(
    (updateResult as unknown as [{ affectedRows?: number }])[0]?.affectedRows ??
      (updateResult as unknown as { affectedRows?: number }).affectedRows ??
      0,
  );
  if (affectedRows !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت السلفة أثناء اعتماد الإلغاء؛ لم يُعكس أي أثر مالي",
    });
  }
}
