import { describe, expect, it } from "vitest";
import { SECTION_CASHIER_ROLES } from "./permissions";
import { getOperationPermission } from "./operationPermissions";
import { buildDefaultRoleOperationPolicy, dailyOperationPaths, ROLE_DAILY_OPERATION_PATHS } from "./roleOperationPresets";

describe("role operation presets", () => {
  it("keeps a fixed snapshot for every role daily-task template", () => {
    expect(ROLE_DAILY_OPERATION_PATHS).toMatchSnapshot();
  });

  it("keeps every declared daily task in the generated delegable catalog", () => {
    for (const [role, paths] of Object.entries(ROLE_DAILY_OPERATION_PATHS))
      for (const path of paths)
        expect(getOperationPermission(path)?.delegable, `${role}:${path}`).toBe(true);
  });

  it("grants reception work, delivery, collection, refund and printing tasks", () => {
    const role = SECTION_CASHIER_ROLES.find((item) => item.key === "reception_clerk")!;
    const policy = buildDefaultRoleOperationPolicy(role.key, role.baseRole, role.permissions);
    for (const path of [
      "workOrders.assign", "delivery.dispatchInvoice", "delivery.settleDaily",
      "reception.collectDeposit", "reception.refundDeposit", "sales.cancel",
      "returns.executeSalesReturnCart", "invoicePrinting.requestPrint",
    ]) expect(policy.grants[`operation.${path}`], path).toBe(true);
  });

  it("does not expose purchases, supplier payments, cost or profit to cashier profiles", () => {
    for (const role of SECTION_CASHIER_ROLES) {
      const policy = buildDefaultRoleOperationPolicy(role.key, role.baseRole, role.permissions);
      expect(policy.dataVisibility).toEqual({ purchaseCost: false, profitMargin: false });
      for (const [key, allowed] of Object.entries(policy.grants))
        if (/operation\.(purchases|purchaseReturns|supplierPayments|accounts|closing)\./.test(key))
          expect(allowed, `${role.key}:${key}`).toBe(false);
    }
  });
});
