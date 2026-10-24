import { describe, expect, it } from "vitest";
import { workflowDispatchNativePaths } from "../../server/services/delivery/workflow/nativeAuthority";
import {
  operationDecision,
  resolveOperationPolicy,
  type OperationPolicy,
} from "../operationPermissions";
import { resolvePermissions } from "../permissions";
const key = (path: string) => `operation.${path}`;
const policy = (paths: Record<string, boolean>): OperationPolicy => ({
  version: 1,
  grants: Object.fromEntries(
    Object.entries(paths).map(([path, allowed]) => [key(path), allowed]),
  ),
});
const resolve = (
  role: Record<string, boolean>,
  user?: Record<string, boolean>,
) =>
  resolveOperationPolicy(
    "cashier",
    resolvePermissions("cashier", null),
    policy(role),
    user ? policy(user) : undefined,
  );
const allowed = (resolved: OperationPolicy, path: string) =>
  operationDecision(
    {
      role: "cashier",
      resolvedOperationPolicy: resolved,
      operationPolicyEnabled: true,
    },
    path,
  ).allowed;

describe("native companions for barcode and checkout stations", () => {
  it("does not turn AE or existing-invoice authority into work-order materialization authority", () => {
    expect(workflowDispatchNativePaths("aftercareExecution")).toEqual([
      "delivery.fulfillment.aftercare.dispatch",
    ]);
    expect(workflowDispatchNativePaths("invoice")).not.toContain(
      "delivery.fulfillment.aftercare.dispatch",
    );
    expect(workflowDispatchNativePaths("workOrder", false)).not.toContain(
      "delivery.dispatchInvoice",
    );
    expect(workflowDispatchNativePaths("workOrder", true)).toContain(
      "delivery.dispatchInvoice",
    );
    expect(workflowDispatchNativePaths("fulfillmentRequest")).toEqual([
      "delivery.fulfillment.requests.release",
    ]);
  });

  it("lets a sparse saved native barcode grant use its typed reader and command without request CRUD or aftercare authority", () => {
    const result = resolve({ "delivery.dispatchByBarcode": true });
    for (const path of [
      "delivery.workflow.preview",
      "delivery.workflow.previewBySource",
      "delivery.workflow.previewBatch",
      "delivery.workflow.dispatchBatch",
    ])
      expect(allowed(result, path)).toBe(true);
    for (const path of [
      "delivery.fulfillment.requests.create",
      "delivery.fulfillment.requests.update",
      "delivery.fulfillment.requests.release",
      "delivery.fulfillment.aftercare.dispatch",
      "delivery.workflow.assignment",
      "delivery.workflow.receiveReturn",
      "delivery.workflow.confirmDelivery",
    ])
      expect(allowed(result, path)).toBe(false);
  });
  it("keeps AE-only dispatch authority separate from invoice and barcode native actions", () => {
    const result = resolve({ "delivery.fulfillment.aftercare.dispatch": true });
    expect(allowed(result, "delivery.workflow.dispatchBatch")).toBe(true);
    expect(allowed(result, "delivery.workflow.preview")).toBe(true);
    for (const path of [
      "delivery.dispatchByBarcode",
      "delivery.dispatchInvoice",
      "delivery.dispatch",
      "delivery.fulfillment.requests.release",
    ])
      expect(allowed(result, path)).toBe(false);
  });
  it("preserves explicit new-path denials and caps an explicit entry grant after primary revocation", () => {
    expect(
      allowed(
        resolve({
          "delivery.dispatchByBarcode": true,
          "delivery.workflow.dispatchBatch": false,
        }),
        "delivery.workflow.dispatchBatch",
      ),
    ).toBe(false);
    expect(
      allowed(
        resolve(
          { "delivery.dispatchByBarcode": true },
          { "delivery.workflow.preview": false },
        ),
        "delivery.workflow.preview",
      ),
    ).toBe(false);
    expect(
      allowed(
        resolve(
          { "delivery.dispatchByBarcode": true },
          {
            "delivery.dispatchByBarcode": false,
            "delivery.workflow.dispatchBatch": true,
          },
        ),
        "delivery.workflow.dispatchBatch",
      ),
    ).toBe(false);
    expect(
      allowed(
        resolve({ "delivery.workflow.dispatchBatch": true }),
        "delivery.workflow.dispatchBatch",
      ),
    ).toBe(false);
  });
  it("opens only the concrete assignment, receipt and confirmation companions needed by their native grants", () => {
    const cancel = resolve({ "delivery.cancelAssignment": true });
    expect(allowed(cancel, "delivery.workflow.assignment")).toBe(true);
    expect(allowed(cancel, "delivery.reassignConsignment")).toBe(false);
    expect(allowed(cancel, "delivery.declareReturn")).toBe(false);
    expect(allowed(cancel, "delivery.workflow.confirmDelivery")).toBe(false);
    expect(
      allowed(
        resolve({ "delivery.returnConsignment": true }),
        "delivery.workflow.receiveReturn",
      ),
    ).toBe(true);
    expect(
      allowed(
        resolve({ "delivery.returnByBarcode": true }),
        "delivery.workflow.receiveReturn",
      ),
    ).toBe(true);
    expect(
      allowed(
        resolve({ "delivery.staffConfirm": true }),
        "delivery.workflow.confirmDelivery",
      ),
    ).toBe(true);
    expect(
      allowed(
        resolve({ "delivery.recordRemittance": true }),
        "delivery.workflow.confirmDelivery",
      ),
    ).toBe(false);
  });
  it.each([
    ["sales.create", "sales"],
    ["printPos.createSale", "printPos"],
    ["workOrders.receptionCheckout", "reception"],
  ])(
    "inherits charge checkout only from its own %s native station",
    (native, station) => {
      const result = resolve({ [native]: true });
      expect(allowed(result, `${station}.checkoutCharges`)).toBe(true);
      expect(allowed(result, `${station}.checkoutChargeOptions`)).toBe(true);
      for (const other of ["sales", "printPos", "reception"].filter(
        (value) => value !== station,
      ))
        expect(allowed(result, `${other}.checkoutCharges`)).toBe(false);
      expect(
        allowed(
          resolve(
            { [native]: true },
            { [native]: false, [`${station}.checkoutCharges`]: true },
          ),
          `${station}.checkoutCharges`,
        ),
      ).toBe(false);
      expect(
        allowed(
          resolve(
            { [native]: true },
            { [`${station}.checkoutCharges`]: false },
          ),
          `${station}.checkoutCharges`,
        ),
      ).toBe(false);
    },
  );
  it("permits reception's proof pair for either real reception checkout route, without granting charge checkout to draft-only staff", () => {
    const result = resolve({}, { "reception.draftCommit": true });
    expect(allowed(result, "reception.initiateExternalPayment")).toBe(true);
    expect(allowed(result, "reception.confirmExternalPayment")).toBe(true);
    expect(allowed(result, "reception.checkoutCharges")).toBe(false);
    expect(allowed(result, "sales.initiateExternalPayment")).toBe(false);
  });
  it("never adds approvals, refunds, costs or changes a primary legacy revocation", () => {
    const result = resolve({
      "delivery.dispatchByBarcode": true,
      "sales.create": true,
      "workOrders.receptionCheckout": true,
    });
    for (const path of [
      "delivery.fulfillment.charges.approve",
      "delivery.fulfillment.aftercare.approve",
      "delivery.fulfillment.charges.refund",
      "delivery.payPartyFees",
    ])
      expect(allowed(result, path)).toBe(false);
    expect(result.dataVisibility).toEqual({
      purchaseCost: false,
      profitMargin: false,
    });
    const revoked = resolveOperationPolicy(
      "cashier",
      resolvePermissions("cashier", null),
      policy({ "sales.create": true }),
      null,
      null,
      {
        inheritedModules: resolvePermissions("cashier", null),
        atomicPermissions: { "pos.invoice.create": false },
      },
    );
    expect(allowed(revoked, "sales.create")).toBe(false);
    expect(allowed(revoked, "sales.checkoutCharges")).toBe(false);
  });
});
