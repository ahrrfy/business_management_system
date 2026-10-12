import { describe, expect, it } from "vitest";
import type { OperationUser } from "@shared/operationPermissions";
import { receptionInvoiceActions, receptionOperationAllowed } from "./receptionOperationAccess";

function account(paths: string[], role = "manager"): OperationUser {
  return { role, operationPolicyEnabled: true, resolvedOperationPolicy: {
    version: 1, grants: Object.fromEntries(paths.map((path) => [`operation.${path}`, true])),
    dataVisibility: { purchaseCost: true, profitMargin: true },
  } };
}
describe("reception lifecycle delegation", () => {
  it("separates collection, dispatch and direct returns from the base role", () => {
    const collected = receptionInvoiceActions(account(["reception.collectOnInvoice"]));
    expect(collected.canCollect).toBe(true);
    expect(collected.canDispatch).toBe(false);
    expect(collected.canCreateReturn).toBe(false);
    const dispatcher = receptionInvoiceActions(account(["delivery.dispatchInvoice", "delivery.listParties"], "warehouse"));
    expect(dispatcher.canDispatch).toBe(true);
    expect(dispatcher.canCollect).toBe(false);
    expect(receptionInvoiceActions(account(["returns.create"], "sales_rep")).canCreateReturn).toBe(true);
  });
  it("requires the real read and write prerequisites of correction and return requests", () => {
    const request = account(["salesControl.requestExchange", "returns.request"]);
    expect(receptionInvoiceActions(request).canCorrect).toBe(false);
    expect(receptionInvoiceActions(request).canRequestReturn).toBe(false);
    for (const path of ["sales.get", "catalog.byUnitIds", "sales.lookupForCorrection"]) request.resolvedOperationPolicy!.grants[`operation.${path}`] = true;
    expect(receptionInvoiceActions(request).canCorrect).toBe(true);
    expect(receptionInvoiceActions(request).canRequestReturn).toBe(true);
    expect(receptionInvoiceActions(request).canCreateReturn).toBe(false);
  });
  it("preserves the actual legacy gates while explicit denial takes precedence", () => {
    expect(receptionOperationAllowed({ role: "cashier" }, "workOrders.receptionCheckout")).toBe(true);
    expect(receptionOperationAllowed({ role: "courier" }, "workOrders.receptionCheckout")).toBe(false);
    expect(receptionOperationAllowed(account([]), "workOrders.receptionCheckout")).toBe(false);
    expect(receptionOperationAllowed(undefined, "branches.list")).toBe(false);
  });
});
