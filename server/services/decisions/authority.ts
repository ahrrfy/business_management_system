import type { DecisionAction } from "@shared/decisionRegistry";
import { canCrossBranches } from "@shared/predicates";
import { getOperationPermission } from "@shared/operationPermissions";
import {
  storedCanonicalOperationAllowed,
  type StoredOperationSnapshot,
} from "../authorization/operationAuthority";
import { gatePasses } from "./gate";
import type { DecisionActor, DecisionSource } from "./types";

/** Original RPC paths, including actions that share a decision endpoint. No module grants are synthesized. */
export const DECISION_OPERATION_PATHS: Readonly<
  Record<string, Partial<Record<DecisionAction | "OPEN", readonly string[]>>>
> = {
  "purchase.order.control": {
    APPROVE: ["purchases.decideControl"],
    REJECT: ["purchases.decideControl"],
  },
  "purchase.requisition.control": {
    APPROVE: ["purchases.decideRequisition"],
    REJECT: ["purchases.decideRequisition"],
  },
  "purchase.charge.control": {
    APPROVE: ["purchaseCharges.decideControl"],
    REJECT: ["purchaseCharges.decideControl"],
  },
  "purchase.integrity.resolution": {
    APPROVE: ["purchaseIntegrity.decideResolution"],
    REJECT: ["purchaseIntegrity.decideResolution"],
  },
  "purchase.return.decide": {
    APPROVE: ["purchaseReturnGovernance.decideReturn"],
    REJECT: ["purchaseReturnGovernance.decideReturn"],
  },
  "purchase.return.reversal": {
    APPROVE: ["purchaseReturnGovernance.decideReversal"],
    REJECT: ["purchaseReturnGovernance.decideReversal"],
  },
  "supplier.payment.decide": {
    APPROVE: ["supplierPayments.decidePayment"],
    REJECT: ["supplierPayments.decidePayment"],
  },
  "supplier.payment.refund": {
    APPROVE: ["supplierPayments.decideRefund"],
    REJECT: ["supplierPayments.decideRefund"],
  },
  "purchase.goodsReceipt.reversal": {
    APPROVE: ["goodsReceiptReversal.decideReversal"],
    REJECT: ["goodsReceiptReversal.decideReversal"],
  },
  "purchase.supplierInvoice.reversal": {
    APPROVE: ["supplierInvoiceApproval.decideApproval"],
    REJECT: ["supplierInvoiceApproval.decideApproval"],
  },
  "inventory.adjustment": {
    APPROVE: ["inventory.approveAdjustment"],
    REJECT: ["inventory.rejectAdjustment"],
  },
  "inventory.costRevaluation": {
    APPROVE: ["inventory.approveCostRevaluation"],
    REJECT: ["inventory.rejectCostRevaluation"],
  },
  "inventory.costWave": {
    APPROVE: ["inventory.approveCostWave"],
    REJECT: ["inventory.rejectCostWave"],
  },
  "treasury.voucher": {
    APPROVE: ["vouchers.approve"],
    REJECT: ["vouchers.reject"],
  },
  expense: { APPROVE: ["expenses.approve"], REJECT: ["expenses.reject"] },
  "expense.accrualCorrection": {
    APPROVE: ["expenses.approveAccrualCorrection"],
    REJECT: ["expenses.rejectAccrualCorrection"],
  },
  "cash.variance": {
    APPROVE: ["treasury.cashVariance.approve"],
    REJECT: ["treasury.cashVariance.reject"],
  },
  "sales.control": {
    APPROVE: ["salesControl.approve"],
    REJECT: ["salesControl.reject"],
  },
  // Approval opens the invoice to choose the refund rail; rejection executes here.
  "sales.returnRequest": {
    OPEN: ["returns.approveRequest"],
    REJECT: ["returns.rejectRequest"],
  },
  "workOrder.control": {
    APPROVE: ["workOrders.approveControl"],
    REJECT: ["workOrders.rejectControl"],
  },
  "workOrder.cancellationRefund": {
    APPROVE: ["workOrders.approveCancellationRefund"],
  },
  "delivery.codWriteOff": {
    APPROVE: ["delivery.approveWriteOffRequest"],
    REJECT: ["delivery.rejectWriteOffRequest"],
  },
  "hr.leave": { APPROVE: ["leaves.decide"], REJECT: ["leaves.decide"] },
  "payroll.remittance": {
    APPROVE: ["payroll.approveRemittance"],
    REJECT: ["payroll.rejectRemittance"],
  },
  "payroll.advanceRepayment": {
    APPROVE: ["payroll.approveAdvanceRepayment"],
    REJECT: ["payroll.rejectAdvanceRepayment"],
  },
  "commissions.run": {
    APPROVE: ["commissions.runs.approveRequest"],
    REJECT: ["commissions.runs.rejectRequest"],
  },
  "closing.monthClose": {
    APPROVE: ["periodLock.approveClose"],
    REJECT: ["periodLock.rejectClose"],
  },
  "closing.yearEndReopen": {
    APPROVE: ["yearEnd.approveReopen"],
    REJECT: ["yearEnd.rejectReopen"],
  },
  "gifts.request": { APPROVE: ["gifts.approveGift"] },
  "delivery.fulfillment.review": {
    OPEN: ["delivery.fulfillment.aftercare.approve"],
  },
  "delivery.fulfillment.settlement": {
    OPEN: ["delivery.fulfillment.aftercare.approveSettlement"],
  },
  "delivery.fulfillment.charge": {
    OPEN: ["delivery.fulfillment.charges.approve"],
  },
  "delivery.fulfillment.followup": {
    OPEN: ["prepare", "dispatch", "resolve", "settlementPost", "payFee"].map(
      (action) => `delivery.fulfillment.aftercare.${action}`,
    ),
  },
};

export function currentDecisionActor(
  actor: DecisionActor,
  current: StoredOperationSnapshot,
): DecisionActor {
  return {
    ...actor,
    role: current.role ?? "user",
    branchId: current.branchId ?? null,
    isOwner: current.isOwner === true,
    permissionsOverride: current.persistedPermissionsOverride ?? null,
    crossBranch: canCrossBranches(current),
    operationUser: current,
  };
}

/** Fixed owner/admin and branch rules survive delegation; only legacy module authority is replaceable. */
export function decisionOperationPasses(
  source: DecisionSource,
  actor: DecisionActor,
  path: string,
): boolean {
  const gate = source.gate;
  if (gate.type === "OWNER" && !actor.isOwner) return false;
  if (gate.type === "REPORTS_ADMIN" && actor.role !== "admin") return false;
  if (
    (gate.type === "MODULE" ||
      (gate.type === "MODULE_MAP" && gate.branchScoped)) &&
    !actor.crossBranch &&
    actor.branchId == null
  )
    return false;
  const operation = getOperationPermission(path);
  if (!operation) return false;
  const canonical = actor.operationUser
    ? storedCanonicalOperationAllowed(actor.operationUser, path)
    : undefined;
  return canonical ?? gatePasses(gate, actor);
}

export function sourceOperationPaths(
  source: DecisionSource,
  action?: DecisionAction,
): readonly string[] {
  const mapping = DECISION_OPERATION_PATHS[source.key];
  return action
    ? (mapping?.[action] ?? [])
    : Object.values(mapping ?? {}).flat();
}

export function sourceAuthorityPasses(
  source: DecisionSource,
  actor: DecisionActor,
  action?: DecisionAction,
): boolean {
  return sourceOperationPaths(source, action).some((path) =>
    decisionOperationPasses(source, actor, path),
  );
}
