import { hasOperationPolicy, operationDecision, type OperationUser } from "@shared/operationPermissions";

/** The mounted operation catalog supplies the same legacy gates and canonical grants. */
export function receptionOperationAllowed(user: OperationUser | null | undefined, path: string): boolean {
  return !!user && operationDecision(user, path).allowed;
}

export function receptionCheckoutPaths(digital: boolean, draft: boolean, offline: boolean, assignsDelivery = false): string[] {
  const paths = digital ? ["prepare", "getIntent", "claimExecution", "markExecution", "finalize"].map((action) => `digitalCards.sales.${action}`)
    : draft ? ["reception.draftSync", "reception.draftCommit"]
    : [offline ? "offline.replayReception" : "workOrders.receptionCheckout"];
  return assignsDelivery ? [...paths, "delivery.dispatchInvoice"] : paths;
}

/** Untouched reception accounts retain the server's legacy compound-checkout contract. */
export function receptionDeliveryAuthorityRequired(user: OperationUser | null | undefined, assignsDelivery: boolean): boolean {
  return !!user && hasOperationPolicy(user) && assignsDelivery;
}

export function receptionInvoiceActions(user: OperationUser | null | undefined) {
  const allowed = (path: string) => receptionOperationAllowed(user, path);
  return {
    canReadInvoice: allowed("sales.get"),
    canCollect: allowed("reception.collectOnInvoice"),
    canConfirmExternalPayment: allowed("sales.initiateExternalPayment") && allowed("sales.confirmExternalPayment"),
    canDispatch: allowed("delivery.dispatchInvoice") && allowed("delivery.listParties"),
    canCorrect: allowed("sales.lookupForCorrection") && allowed("sales.get") && allowed("catalog.byUnitIds") &&
      (allowed("sales.reissue") || allowed("salesControl.requestExchange")),
    canCreateReturn: allowed("returns.create"),
    canRequestReturn: allowed("returns.request") && allowed("sales.get"),
  };
}
