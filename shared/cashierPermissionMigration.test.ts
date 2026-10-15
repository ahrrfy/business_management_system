import { describe, expect, it } from "vitest";
import { legacyOperationPolicy, operationDecision } from "./operationPermissions";
import { resolvePermissions } from "./permissions";

describe("safe cashier policy conversion", () => {
  const modules = resolvePermissions("cashier", { treasury: "FULL", reports: "FULL", workorders: "FULL", sales: "READ", pos: "NONE" });
  it("does not turn coarse cashier treasury access into company financial authority", () => {
    const policy = legacyOperationPolicy("cashier", modules);
    for (const path of ["treasury.getDashboard", "treasury.getKpiTrends", "treasury.getCashFlowSeries", "treasury.getPaymentMethodBreakdown", "reports.dashboardMetrics", "exchange.list", "treasury.cashVariance.approve", "vouchers.aggregate", "vouchers.list", "cashTransfers.list", "cashTransfers.send", "supplierPayments.decidePayment", "supplierPayments.decideRefund", "offline.salesReport", "executive.commandCenter", "installments.list", "voucherCategories.unclassifiedOther"])
      expect(policy.grants[`operation.${path}`], path).toBe(false);
    for (const path of ["shifts.current", "shifts.open", "shifts.close", "workOrders.receptionCheckout", "invoicePrinting.requestPrint", "invoicePrinting.requestReprint"])
      expect(policy.grants[`operation.${path}`], path).toBe(true);
  });
  it("still honors a deliberately selected independent financial operation", () => {
    const policy = { version: 1 as const, grants: { "operation.treasury.getDashboard": true } };
    expect(operationDecision({ role: "cashier", operationPolicyEnabled: true, resolvedOperationPolicy: policy }, "treasury.getDashboard").allowed).toBe(true);
  });
});
