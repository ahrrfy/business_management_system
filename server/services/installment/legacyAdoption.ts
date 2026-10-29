import { eq } from "drizzle-orm";
import { moduleAccessAllowed, type PermissionMap } from "@shared/permissions";
import { installmentPlans, invoices } from "../../../drizzle/schema";
import { logAuditTx } from "../auditService";
import { type Actor, withTx } from "../tx";
import { withOperationAuthority } from "../authorization/operationExecutionScope";
import { assertPlanBranch, type BranchRestriction } from "./types";
import { adoptProvenLegacyPlanTx, assertInstallmentScopeTx, installmentConflict, lockInstallmentPlanTx } from "./receiptAllocations";

/** Evidence-only recovery. Never collects, refunds or changes the original schedule. */
export async function adoptLegacyHistory(planId: number, actor: Actor, restriction: BranchRestriction = null) {
  return withOperationAuthority({ actor, path: "installments.adoptLegacyHistory",
    legacyAllowed: current => moduleAccessAllowed(current.role ?? "user", current.permissionsOverride as PermissionMap | null,
      "treasury", "FULL", ["manager", "accountant"])
      && current.resolvedOperationPolicy?.grants["operation.installments.adoptLegacyHistory"] !== false,
  }, () => withTx(async tx => {
    const [preview] = await tx.select().from(installmentPlans).where(eq(installmentPlans.id, planId));
    if (!preview || preview.invoiceId == null) installmentConflict("الخطة التاريخية غير مرتبطة بفاتورة");
    assertPlanBranch(preview.branchId, restriction);
    if (actor.role !== "admin") assertPlanBranch(preview.branchId, actor.branchId);
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, preview.invoiceId)).for("update");
    if (!invoice) installmentConflict("الفاتورة الأصلية مفقودة");
    await adoptProvenLegacyPlanTx(tx, invoice, planId);
    const state = await lockInstallmentPlanTx(tx, planId);
    if (!state || state.plan.status === "CANCELLED" || state.plan.invoiceId !== invoice.id
      || state.plan.customerId !== invoice.customerId || state.plan.branchId !== invoice.branchId)
      installmentConflict("تغير مصدر الخطة أو أُلغيت");
    assertPlanBranch(state.plan.branchId, restriction);
    await assertInstallmentScopeTx(tx, state, invoice);
    await logAuditTx(tx, { userId: actor.userId, branchId: state.plan.branchId }, {
      action: "installment.plan.adoptLegacyHistory", entityType: "installmentPlan", entityId: planId,
      newValue: { invoiceId: invoice.id, lineIds: state.lines.map(line => line.id) },
    });
    return { planId, reconciled: true as const };
  }));
}
