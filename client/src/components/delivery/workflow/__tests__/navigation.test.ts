import { describe, expect, it } from "vitest";
import { legacyFulfillmentWorkflowHref, positiveWorkflowParam, workflowSection, workflowSourceContext, workflowSourceBarcode } from "../navigation";
import { APPLICATION_MODULES } from "@/lib/moduleRegistry";
import { canSeeGate, RECEPTION_STATION_GATE } from "@/lib/navVisibility";

describe("same workflow station links", () => {
  it("retains colliding display numbers in their actual source namespace", () => {
    expect(workflowSourceBarcode({kind:"invoice",number:"100001"})).toBe("INV-100001");
    expect(workflowSourceBarcode({kind:"consignment",number:"100001"})).toBe("CN-100001");
    expect(workflowSourceBarcode({kind:"workOrder",number:"WO-1-20260818-00073"})).toBe("WO-1-20260818-00073");
    expect(workflowSourceContext("?consignmentId=8")).toEqual({kind:"consignment",id:8});
    expect(workflowSourceContext("?onlineOrderId=9")).toEqual({kind:"onlineOrder",id:9});
  });
  it.each(["cancelAssignment", "cancel_assignment", "cancel-assignment"])("retains printed/legacy station alias %s", section => {
    expect(workflowSection(`?section=${section}`)).toBe("cancelAssignment");
  });
  it("preserves explicit original IDs and draft context when redirecting a legacy workspace", () => {
    const href = legacyFulfillmentWorkflowHref("?tab=fulfillment&kind=aftercare&branchId=2&caseId=41&executionId=88&draftId=9");
    const [path, search] = href.split("?");
    expect(path).toBe("/delivery");
    const params = new URLSearchParams(search);
    expect(params.get("tab")).toBe("workflow");
    expect(params.has("kind")).toBe(false);
    expect(params.get("section")).toBe("aftercare");
    expect(params.get("caseId")).toBe("41");
    expect(params.get("draftId")).toBe("9");
    expect(workflowSourceContext(search)).toEqual({ kind: "aftercareExecution", id: 88 });
  });
  it.each(["edit", "return", "cancelAssignment"])("keeps explicit %s station and document/draft context on the delivery route", section => {
    const href = legacyFulfillmentWorkflowHref(`?tab=fulfillment&section=${section}&invoiceId=24&draftId=9&branchId=2`);
    const [path, search] = href.split("?"); const params = new URLSearchParams(search);
    expect(path).toBe("/delivery"); expect(params.get("tab")).toBe("workflow");
    expect(workflowSection(search)).toBe(section); expect(params.get("draftId")).toBe("9"); expect(params.get("branchId")).toBe("2");
    expect(workflowSourceContext(search)).toEqual({ kind: "invoice", id: 24 });
  });
  it("keeps a delivery user without reception access inside the existing store gate", () => {
    const [path, search] = legacyFulfillmentWorkflowHref("?tab=fulfillment&kind=refunds&chargeId=23").split("?");
    const gate = APPLICATION_MODULES.find(entry => entry.href === path);
    expect(gate?.id).toBe("delivery");
    const permissions = { store: "FULL", workorders: "NONE" } as const;
    expect(canSeeGate(gate, "cashier", permissions)).toBe(true);
    expect(canSeeGate(RECEPTION_STATION_GATE, "cashier", permissions)).toBe(false);
    expect(new URLSearchParams(search).get("action")).toBe("refunds");
    expect(workflowSourceContext(search)).toEqual({ kind: "charge", id: 23 });
  });
  it("opens real charges in collection and never interprets a barcode as an internal ID", () => {
    const href = legacyFulfillmentWorkflowHref("?kind=charges&chargeId=23&branchId=1");
    expect(href).toContain("section=collect");
    expect(href).toContain("action=charges");
    expect(workflowSourceContext("?invoice=12345")).toBeNull();
    expect(workflowSourceContext("?invoiceId=INV-12345")).toBeNull();
    for (const value of ["0", "-1", "1e2", "9007199254740992"]) expect(positiveWorkflowParam(new URLSearchParams({ requestId: value }), "requestId")).toBeUndefined();
  });
});
