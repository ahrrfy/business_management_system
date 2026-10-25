import type {
  WorkflowSourceIdentity,
  WorkflowSourceKind,
  WorkflowStation,
} from "@shared/deliveryWorkflow";
import { docBarcode } from "@shared/documentNumber";

export function explicitWorkflowSection(
  search: string,
): WorkflowStation | null {
  const section = new URLSearchParams(search).get("section");
  if (
    section === "collect" ||
    section === "edit" ||
    section === "return" ||
    section === "aftercare"
  )
    return section;
  if (
    section === "cancelAssignment" ||
    section === "cancel_assignment" ||
    section === "cancel-assignment"
  )
    return "cancelAssignment";
  if (section === "dispatch") return "dispatch";
  return null;
}
export function workflowSection(search: string): WorkflowStation {
  return explicitWorkflowSection(search) ?? "dispatch";
}
export function positiveWorkflowParam(
  params: URLSearchParams,
  key: string,
): number | undefined {
  const raw = params.get(key);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
export function workflowSourceContext(
  search: string,
): { kind: WorkflowSourceKind; id: number } | null {
  const params = new URLSearchParams(search);
  for (const [key, kind] of [
    ["executionId", "aftercareExecution"],
    ["requestId", "fulfillmentRequest"],
    ["chargeId", "charge"],
    ["consignmentId", "consignment"],
    ["onlineOrderId", "onlineOrder"],
    ["invoiceId", "invoice"],
    ["workOrderId", "workOrder"],
  ] as const) {
    const id = positiveWorkflowParam(params, key);
    if (id) return { kind, id };
  }
  return null;
}
/** Retain the actual namespace when opening a typed link through a barcode station. */
export function workflowSourceBarcode(
  source: Pick<WorkflowSourceIdentity, "kind" | "number">,
): string {
  const prefixes: Record<WorkflowSourceKind, string> = {
    invoice: "INV",
    workOrder: "WO",
    onlineOrder: "ORD",
    consignment: "CN",
    fulfillmentRequest: "FR",
    aftercareExecution: "AE",
    charge: "CHG",
  };
  return docBarcode(prefixes[source.kind], source.number);
}
export function legacyFulfillmentWorkflowHref(search: string): string {
  const params = new URLSearchParams(search);
  const kind = params.get("kind");
  params.delete("tab");
  params.delete("kind");
  if (!params.has("section"))
    params.set(
      "section",
      kind === "aftercare"
        ? "aftercare"
        : kind === "charges" || kind === "refunds"
          ? "collect"
          : "dispatch",
    );
  if (kind === "charges" || kind === "refunds") params.set("action", kind);
  return `/delivery?tab=workflow&${params}`;
}
