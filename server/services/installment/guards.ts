import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { installmentPlans } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/**
 * Rejects any operation that would change the economics or debtor of an invoice
 * while its collection schedule is still ACTIVE.
 *
 * Lock contract: the caller MUST already hold `invoices.id = invoiceId FOR UPDATE`.
 * Every governed plan creator locks that invoice before looking for an active
 * plan, so this plan-row lock closes return/reissue/customer-change races without
 * introducing a plan -> invoice lock inversion.
 */
export async function assertNoActiveInstallmentPlanAfterInvoiceLockTx(
  tx: Tx,
  input: {
    invoiceId: number;
    operationLabel: string;
  },
): Promise<void> {
  const active = (
    await tx
      .select({ id: installmentPlans.id })
      .from(installmentPlans)
      .where(
        and(
          eq(installmentPlans.invoiceId, input.invoiceId),
          eq(installmentPlans.status, "ACTIVE"),
        ),
      )
      .for("update")
      .limit(1)
  )[0];

  if (active) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `لا يمكن ${input.operationLabel} لأن الفاتورة مرتبطة بخطة أقساط نشطة #${Number(active.id)}. ` +
        "ألغِ الخطة أو أكملها، ثم أنشئ جدولة جديدة محكومة على الرصيد المحدّث.",
    });
  }
}
