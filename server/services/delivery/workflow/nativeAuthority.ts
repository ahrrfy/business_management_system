import type { WorkflowSourceKind } from "../../../../shared/deliveryWorkflow";

/** Exact native source operations; the shared entry grant is never source authority. */
export function workflowDispatchNativePaths(
  kind: WorkflowSourceKind,
  hasMaterializedInvoice = false,
): string[] {
  if (kind === "aftercareExecution")
    return ["delivery.fulfillment.aftercare.dispatch"];
  if (kind === "fulfillmentRequest")
    return ["delivery.fulfillment.requests.release"];
  if (kind === "workOrder")
    return [
      "delivery.dispatch",
      "delivery.dispatchByBarcode",
      ...(hasMaterializedInvoice ? ["delivery.dispatchInvoice"] : []),
    ];
  if (kind === "invoice")
    return ["delivery.dispatchInvoice", "delivery.dispatchByBarcode"];
  return ["delivery.dispatchByBarcode", "storeAdmin.orders.dispatch"];
}
