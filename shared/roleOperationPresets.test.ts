import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES, SECTION_CASHIER_ROLES } from "./permissions";
import {
  applyLegacyIndividualOperationOverrides,
  getOperationPermission,
} from "./operationPermissions";
import { buildDefaultRoleOperationPolicy, dailyOperationPaths, ROLE_DAILY_OPERATION_PATHS } from "./roleOperationPresets";

const REQUIRED_CASHIER_RETURN_OPERATIONS = [
  "returns.create",
  "returns.executeSalesReturnCart",
  "returns.getOpenRefundDrawers",
  "returns.getInvoice",
  "returns.inspectInvoiceForReturn",
  "returns.lookupItemForReturn",
  "returns.universalScan",
  "returns.forensicTrace",
  "returns.shifts",
  "returns.request",
  "returns.requests",
  "refundRails.preflight",
] as const;

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

  it("grants the full 12 sales return operations to retail cashier, print cashier, and reception cashier presets and legacy module overrides", () => {
    const cashier = buildDefaultRoleOperationPolicy("cashier", "cashier", ROLE_TEMPLATES.cashier);
    for (const path of REQUIRED_CASHIER_RETURN_OPERATIONS) {
      expect(cashier.grants[`operation.${path}`], `cashier:${path}`).toBe(true);
    }

    for (const role of SECTION_CASHIER_ROLES) {
      const policy = buildDefaultRoleOperationPolicy(role.key, role.baseRole, role.permissions);
      for (const path of REQUIRED_CASHIER_RETURN_OPERATIONS) {
        expect(policy.grants[`operation.${path}`], `${role.key}:${path}`).toBe(true);
      }
      expect(policy.grants["operation.returns.executePurchaseReturnCart"]).toBe(false);
    }

    // Legacy Print Cashier (pos: FULL, sales: NONE, workorders: NONE) on print_operator or cashier baseRole
    for (const baseRole of ["print_operator", "cashier"] as const) {
      const inherited = buildDefaultRoleOperationPolicy(
        baseRole,
        baseRole,
        ROLE_TEMPLATES[baseRole],
      );
      const bridged = applyLegacyIndividualOperationOverrides(
        inherited,
        baseRole,
        ROLE_TEMPLATES[baseRole],
        {
          ...ROLE_TEMPLATES[baseRole],
          pos: "FULL",
          sales: "NONE",
          workorders: "NONE",
        },
        null,
      );
      for (const path of REQUIRED_CASHIER_RETURN_OPERATIONS) {
        expect(bridged.grants[`operation.${path}`], `legacy-print(${baseRole}):${path}`).toBe(true);
      }
    }

    // Legacy Reception Cashier (workorders: FULL, pos: READ, sales: NONE) on print_operator or cashier baseRole
    for (const baseRole of ["print_operator", "cashier"] as const) {
      const inherited = buildDefaultRoleOperationPolicy(
        baseRole,
        baseRole,
        ROLE_TEMPLATES[baseRole],
      );
      const bridged = applyLegacyIndividualOperationOverrides(
        inherited,
        baseRole,
        ROLE_TEMPLATES[baseRole],
        {
          ...ROLE_TEMPLATES[baseRole],
          workorders: "FULL",
          pos: "READ",
          sales: "NONE",
        },
        null,
      );
      for (const path of REQUIRED_CASHIER_RETURN_OPERATIONS) {
        expect(bridged.grants[`operation.${path}`], `legacy-reception(${baseRole}):${path}`).toBe(true);
      }
    }
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

  it("preserves operation role allowlists and keeps print cashiers out of retail sales", () => {
    const cashier = buildDefaultRoleOperationPolicy("cashier", "cashier", ROLE_TEMPLATES.cashier);
    expect(cashier.grants["operation.salesControl.approve"]).toBe(false);
    expect(cashier.grants["operation.sales.correct"]).toBe(false);

    const printRole = SECTION_CASHIER_ROLES.find((item) => item.key === "print_cashier")!;
    const printPolicy = buildDefaultRoleOperationPolicy(printRole.key, printRole.baseRole, rolePermissions(printRole));
    expect(printPolicy.grants["operation.printPos.createSale"]).toBe(true);
    expect(printPolicy.grants["operation.sales.cancel"]).toBe(true);
    expect(printPolicy.grants["operation.returns.getInvoice"]).toBe(true);
    expect(printPolicy.grants["operation.returns.inspectInvoiceForReturn"]).toBe(true);
    expect(printPolicy.grants["operation.sales.create"]).toBe(false);
  });

  it("keeps routine cash expense and own-drawer supplier source dependencies available", () => {
    const cashier = buildDefaultRoleOperationPolicy("cashier", "cashier", ROLE_TEMPLATES.cashier);
    expect(cashier.grants["operation.expenses.create"]).toBe(true);

    const purchasing = buildDefaultRoleOperationPolicy(
      "purchasing",
      "purchasing",
      ROLE_TEMPLATES.purchasing,
    );
    expect(purchasing.grants["operation.supplierPayments.cashSources"]).toBe(true);
    expect(purchasing.grants["operation.supplierPayments.decidePayment"]).toBe(false);
  });

  it("does not restore daily operations after their module is explicitly revoked", () => {
    const retail = SECTION_CASHIER_ROLES.find((item) => item.key === "retail_cashier")!;
    const modules = { ...retail.permissions, sales: "NONE" as const };
    const policy = buildDefaultRoleOperationPolicy(
      "retail_cashier",
      "cashier",
      modules,
    );
    expect(policy.grants["operation.sales.create"]).toBe(false);
    expect(policy.grants["operation.sales.cancel"]).toBe(false);
    expect(policy.grants["operation.returns.executeSalesReturnCart"]).toBe(false);

    const reception = SECTION_CASHIER_ROLES.find((item) => item.key === "reception_clerk")!;
    const receptionPolicy = buildDefaultRoleOperationPolicy(
      reception.key,
      reception.baseRole,
      { ...reception.permissions, store: "NONE" },
    );
    expect(receptionPolicy.grants["operation.workOrders.assign"]).toBe(true);
    expect(receptionPolicy.grants["operation.delivery.dispatchInvoice"]).toBe(false);
    expect(receptionPolicy.grants["operation.delivery.cancelAssignment"]).toBe(false);
    expect(receptionPolicy.grants["operation.delivery.settleDaily"]).toBe(false);
  });

  it("keeps a station daily-operation bridge when its related module is broadened", () => {
    const printRole = SECTION_CASHIER_ROLES.find((item) => item.key === "print_cashier")!;
    const policy = buildDefaultRoleOperationPolicy(
      printRole.key,
      printRole.baseRole,
      { ...printRole.permissions, sales: "READ" },
    );

    expect(policy.grants["operation.sales.cancel"]).toBe(true);
    expect(policy.grants["operation.returns.executeSalesReturnCart"]).toBe(true);
  });
});

function rolePermissions(role: (typeof SECTION_CASHIER_ROLES)[number]) {
  return role.permissions;
}
