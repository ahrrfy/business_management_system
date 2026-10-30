import { and, eq } from "drizzle-orm";
import {
  idempotencyKeys,
  installmentLines,
  installmentPlans,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { idempotencyHash } from "../idempotency";
import { toDbMoney } from "../money";
import {
  installmentConflict,
  lockInstallmentPlanTx,
} from "./receiptAllocations";

export type ClaimReceipt = Pick<
  typeof receipts.$inferSelect,
  "id" | "amount" | "branchId" | "partyId"
>;
function claimHash(
  lineId: number,
  plan: typeof installmentPlans.$inferSelect,
  receipt: ClaimReceipt,
) {
  return idempotencyHash({
    lineId,
    planId: plan.id,
    invoiceId: plan.invoiceId,
    customerId: plan.customerId,
    branchId: plan.branchId,
    receiptId: receipt.id,
    amount: toDbMoney(receipt.amount),
  });
}

/** Called only by the trusted installment writer after its real receipt exists. */
export async function saveInstallmentReceiptClaimTx(
  tx: Tx,
  lineId: number,
  plan: typeof installmentPlans.$inferSelect,
  receipt: ClaimReceipt,
  pending: boolean,
) {
  const id = extractInsertId(
    await tx
      .insert(idempotencyKeys)
      .values({
        operation: "installment.receipt",
        clientRequestId: `${lineId}:${receipt.id}`,
        refId: receipt.id,
        payloadHash: claimHash(lineId, plan, receipt),
      }),
  );
  await tx
    .update(installmentLines)
    .set({
      receiptId: receipt.id,
      pendingAllocationClaimId: pending ? id : null,
    })
    .where(eq(installmentLines.id, lineId));
}

/** Native approval/rejection already owns its receipt. Discover only within its current invoice/plan. */
export async function pendingInstallmentTargetTx(
  tx: Tx,
  invoiceId: number | null,
  receipt: ClaimReceipt,
  clear = false,
) {
  if (invoiceId == null) return undefined;
  await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");
  // A competing ordinary payment may have completed the plan while this receipt waited.
  const candidates = await tx
    .select({ id: installmentPlans.id })
    .from(installmentPlans)
    .where(eq(installmentPlans.invoiceId, invoiceId));
  for (const candidate of candidates) {
    const state = await lockInstallmentPlanTx(tx, candidate.id, true);
    if (!state) continue;
    for (const line of state.lines) {
      if (line.pendingAllocationClaimId == null) continue;
      const [claim] = await tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.id, line.pendingAllocationClaimId))
        .for("share");
      if (!claim || claim.operation !== "installment.receipt")
        installmentConflict("هوية حجز التحصيل مفقودة");
      if (claim.refId !== receipt.id) continue;
      if (
        claim.clientRequestId !== `${line.id}:${receipt.id}` ||
        claim.payloadHash !== claimHash(line.id, state.plan, receipt) ||
        state.plan.branchId !== receipt.branchId ||
        state.plan.customerId !== receipt.partyId
      )
        installmentConflict("هوية سند القسط لا تطابق الحجز الأصلي");
      if (clear)
        await tx
          .update(installmentLines)
          .set({ pendingAllocationClaimId: null })
          .where(
            and(
              eq(installmentLines.id, line.id),
              eq(installmentLines.pendingAllocationClaimId, claim.id),
            ),
          );
      return line.id;
    }
  }
  return undefined;
}
