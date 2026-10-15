import { describe, expect, it } from "vitest";
import { lifecycleActionAllowed } from "./lifecycleActionPermission";
import { useInvoiceActionPermissions } from "@/hooks/useInvoiceActionPermissions";
import type { OperationUser } from "@shared/operationPermissions";

const canonical = (
  grants: Record<string, boolean>,
  role = "sales_rep",
): OperationUser => ({
  role,
  operationPolicyEnabled: true,
  roleOperationPolicy: { version: 1, grants },
});

describe("lifecycle UI follows independent operation grants", () => {
  it("does not let a broad legacy module grant bypass a saved operation denial", () => {
    const user = {
      ...canonical({}, "manager"),
      permissionsOverride: { sales: "FULL", store: "FULL" },
    };
    expect(lifecycleActionAllowed(user, "salesControl.approve", true)).toBe(
      false,
    );
    expect(
      lifecycleActionAllowed(user, "delivery.cancelAssignment", true),
    ).toBe(false);
  });

  it("allows a delegated operation outside the baseline role without enabling its neighbors", () => {
    const user = canonical({
      "operation.delivery.addPartyMember": true,
      "operation.salesControl.reject": true,
    });
    expect(lifecycleActionAllowed(user, "delivery.addPartyMember", false)).toBe(
      true,
    );
    expect(
      lifecycleActionAllowed(user, "delivery.removePartyMember", true),
    ).toBe(false);
    expect(lifecycleActionAllowed(user, "salesControl.reject", false)).toBe(
      true,
    );
    expect(lifecycleActionAllowed(user, "salesControl.approve", true)).toBe(
      false,
    );
  });

  it("applies one user denial without altering another action or the shared role policy", () => {
    const rolePolicy = {
      version: 1 as const,
      grants: { "operation.sales.pay": true, "operation.sales.cancel": true },
    };
    const user: OperationUser = {
      role: "cashier",
      roleOperationPolicy: rolePolicy,
      operationPolicy: { version: 1, grants: { "operation.sales.pay": false } },
    };
    expect(lifecycleActionAllowed(user, "sales.pay", true)).toBe(false);
    expect(lifecycleActionAllowed(user, "sales.cancel", false)).toBe(true);
    expect(rolePolicy.grants["operation.sales.pay"]).toBe(true);
  });

  it("preserves the preexisting legacy UI decision before canonical policy activation", () => {
    expect(lifecycleActionAllowed({ role: "cashier" }, "sales.pay", true)).toBe(
      true,
    );
    expect(
      lifecycleActionAllowed({ role: "cashier" }, "sales.pay", false),
    ).toBe(false);
    expect(lifecycleActionAllowed(null, "sales.pay", true)).toBe(false);
  });

  it("keeps owner authority and fails closed for an unregistered operation", () => {
    const owner = { ...canonical({}), isOwner: true };
    expect(
      lifecycleActionAllowed(owner, "invoicePrinting.requestReprint", false),
    ).toBe(true);
    expect(lifecycleActionAllowed(owner, "unregistered.action", true)).toBe(
      false,
    );
  });

  it("keeps invoice metadata, due-date request, history, payment and printing independent", () => {
    const actions = useInvoiceActionPermissions(
      canonical({
        "operation.salesControl.requestDueDateChange": true,
        "operation.sales.correctionHistory": true,
        "operation.sales.pay": true,
        "operation.invoicePrinting.requestPrint": true,
        "operation.documentDelivery.downloadPdf": true,
      }),
    );
    expect(actions.canRequestDueDateChange).toBe(true);
    expect(actions.canReadCorrectionHistory).toBe(true);
    expect(actions.canRecordPayment).toBe(true);
    expect(actions.canCorrectInvoice).toBe(false);
    expect(actions.canInitiatePayment).toBe(false);
    expect(actions.canConfirmPayment).toBe(false);
    expect(actions.canReprint).toBe(false);
    expect(actions.canDownloadPdf).toBe(true);
  });
});
