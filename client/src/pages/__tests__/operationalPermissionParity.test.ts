import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPLICATION_MODULES } from "@/lib/moduleRegistry";
import { canSeeGate } from "@/lib/navVisibility";
import {
  EDITOR_OPERATION_GATES,
  PURCHASE_RETURNS_GOVERNANCE_GATE,
  RETURNS_WORKSPACE_GATE,
} from "@/lib/navVisibility";
import type { OperationPolicy } from "@shared/operationPermissions";
import { moduleAccessAllowed } from "@shared/permissions";

const readPage = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

const readComponent = (relative: string) =>
  readFileSync(new URL(`../../components/${relative}`, import.meta.url), "utf8");

const section = (source: string, start: string, end: string) => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing end marker: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
};

describe("operational UI permission parity", () => {
  it("keeps production tabs on inventory FULL with the manager role fallback", () => {
    const source = readPage("PrintHub.tsx");

    for (const tab of ["production", "recipes"]) {
      const declaration = source
        .split(/\r?\n/)
        .find((line) => line.includes(`value: "${tab}"`));

      expect(declaration, `${tab} tab declaration`).toContain(
        'gate: { roles: ["manager"], module: "inventory", level: "FULL" }',
      );
    }

    expect(
      moduleAccessAllowed("manager", null, "inventory", "FULL", ["manager"]),
    ).toBe(true);
    expect(
      moduleAccessAllowed(
        "accountant",
        { inventory: "FULL" },
        "inventory",
        "FULL",
        ["manager"],
      ),
    ).toBe(true);
    expect(
      moduleAccessAllowed(
        "manager",
        { inventory: "READ" },
        "inventory",
        "FULL",
        ["manager"],
      ),
    ).toBe(false);
    expect(
      moduleAccessAllowed("accountant", null, "inventory", "FULL", ["manager"]),
    ).toBe(false);
  });

  it("keeps the print hub discoverable through workorders or inventory FULL", () => {
    const workOrders = APPLICATION_MODULES.find(
      (module) => module.id === "workOrders",
    );

    expect(workOrders?.anyOf).toEqual([
      { module: "workorders" },
      { roles: ["manager"], module: "inventory", level: "FULL" },
    ]);
    expect(canSeeGate(workOrders, "print_operator", null)).toBe(true);
    expect(
      canSeeGate(workOrders, "accountant", {
        workorders: "NONE",
        inventory: "FULL",
      }),
    ).toBe(true);
    expect(
      canSeeGate(workOrders, "accountant", {
        workorders: "NONE",
        inventory: "READ",
      }),
    ).toBe(false);
  });

  it("binds dispatch and manual proof to exact operations while preserving legacy remittance gate", () => {
    const source =
      readPage("DeliveryHub.tsx") +
      "\n" +
      readComponent("delivery/DeliverySettleTab.tsx") +
      "\n" +
      readComponent("delivery/DeliverySettleSummaryCard.tsx");
    const dispatchAuthority = section(
      source,
      "const canDispatch",
      "const [target",
    );
    const dispatchActions = section(source, "<RowActions", "<DispatchDialog");
    const manualProofAuthority = section(
      source,
      "const isManager",
      "// ── Mutations",
    );
    const manualProofAction = section(
      source,
      "{isManager && (r.viewKey",
      "{phone &&",
    );
    const remitAuthority = section(source, "const canRemit", "const canReturn");
    const remitAction = section(source, "{canRemit && (", "</Button>");

    expect(dispatchAuthority).toContain('useOperationPermission("delivery.dispatch")');
    expect(dispatchAuthority).toContain('useOperationPermission("delivery.dispatchByBarcode")');
    expect(dispatchActions).toContain('o.sourceType === "ONLINE_ORDER"');
    expect(dispatchActions).toContain('operations:');
    expect(dispatchActions).toContain('"delivery.dispatchByBarcode"');
    expect(manualProofAuthority).toContain('useOperationPermission("delivery.manualProof")');
    expect(manualProofAction).toContain("setManualProofTarget(r)");
    expect(remitAuthority).toMatch(
      /moduleAccessAllowed\([\s\S]*?"store",\s*"FULL",\s*\["cashier", "manager"\]/,
    );
    expect(remitAction).toMatch(/title=\{\s*listStillLoading\s*\?/);

    expect(
      moduleAccessAllowed("cashier", null, "store", "FULL", [
        "cashier",
        "manager",
      ]),
    ).toBe(true);
    expect(
      moduleAccessAllowed("cashier", { store: "NONE" }, "store", "FULL", [
        "cashier",
        "manager",
      ]),
    ).toBe(false);
    expect(
      moduleAccessAllowed("manager", null, "store", "FULL", ["manager"]),
    ).toBe(true);
    expect(
      moduleAccessAllowed("cashier", null, "store", "FULL", ["manager"]),
    ).toBe(false);
  });

  it("keeps production cancellation on inventory FULL authority", () => {
    const source = readPage("ProductionDetail.tsx");
    const authority = section(source, "const isManager", "const utils");
    const action = section(
      source,
      '{isManager && doc.status !== "CANCELLED"',
      "</div>",
    );

    expect(authority).toMatch(
      /moduleAccessAllowed\([\s\S]*?"inventory",\s*"FULL",\s*\["manager"\]/,
    );
    expect(action).toContain("onClick={onCancel}");
    expect(action).toContain("إلغاء المستند (يعكس المخزون)");
  });

  it("routes purchase-return executors and request-only users to their matching workflows", () => {
    const source =
      readPage("Purchases.tsx") +
      "\n" +
      readComponent("purchases/PurchaseDetailDrawer.tsx");

    expect(source).not.toContain('"purchaseReturns.create"');
    expect(source).toContain('"returns.executePurchaseReturnCart"');
    expect(source).toContain('"purchaseReturnGovernance.requestReturn"');
    expect(source).toContain('"/purchases/returns-governance"');
    expect(source).toContain("canExecutePurchaseReturn");
    expect(source).toContain("canRequestPurchaseReturn");
    for (const dependency of [
      '"returns.lookupItemForReturn"',
      '"purchaseReturnGovernance.returnSources"',
      '"suppliers.list"',
    ]) {
      expect(source).toContain(dependency);
    }
  });

  it("shows the effective inherited refund cap in role operation rows", () => {
    const source = readPage("RoleEdit.tsx");
    expect(source).toContain("inheritedOperationalCaps={resolveOperationalCaps(");
    expect(source).toContain("const caps = (row.operationalCaps as OperationalCaps | null) ?? {};");
    expect(source).not.toContain("?? resolveOperationalCaps(roleKey");
  });

  it("requires every delegated workflow read before opening its page", () => {
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    const governance = readPage("PurchaseReturnsGovernance.tsx");
    const operationPolicy = (paths: string[]): OperationPolicy => ({
      version: 1,
      grants: Object.fromEntries(paths.map((path) => [`operation.${path}`, true])),
      dataVisibility: { purchaseCost: true, profitMargin: true },
    });

    expect(canSeeGate(RETURNS_WORKSPACE_GATE, "manager", null, operationPolicy([
      "returns.executePurchaseReturnCart",
      "returns.lookupItemForReturn",
      "suppliers.list",
    ]))).toBe(true);
    expect(canSeeGate(RETURNS_WORKSPACE_GATE, "manager", null, operationPolicy([
      "returns.getRequest",
      "returns.getInvoice",
      "returns.approveRequest",
    ]))).toBe(true);
    expect(canSeeGate(PURCHASE_RETURNS_GOVERNANCE_GATE, "purchasing", null, operationPolicy([
      "purchaseReturnGovernance.requestReversal",
    ]))).toBe(false);
    expect(canSeeGate(PURCHASE_RETURNS_GOVERNANCE_GATE, "purchasing", null, operationPolicy([
      "purchaseReturnGovernance.reversalSources",
      "purchaseReturnGovernance.requestReversal",
    ]))).toBe(true);
    expect(canSeeGate(PURCHASE_RETURNS_GOVERNANCE_GATE, "purchasing", null, operationPolicy([
      "purchaseReturnGovernance.pendingReturns",
      "purchaseReturnGovernance.decideReturn",
    ]))).toBe(true);
    expect(canSeeGate(EDITOR_OPERATION_GATES.purchase, "purchasing", null, operationPolicy([
      "purchases.get",
      "purchases.updateOrder",
    ]))).toBe(false);
    expect(canSeeGate(EDITOR_OPERATION_GATES.purchase, "purchasing", null, operationPolicy([
      "purchases.get",
      "purchases.updateOrder",
      "suppliers.get",
      "suppliers.search",
    ]))).toBe(true);

    expect(app).toContain("canonicalGate={RETURNS_WORKSPACE_GATE}");
    expect(APPLICATION_MODULES.find((module) => module.id === "returns")?.anyOf)
      .toEqual(RETURNS_WORKSPACE_GATE.anyOf);
    expect(app).toContain("canonicalGate={PURCHASE_RETURNS_GOVERNANCE_GATE}");
    expect(governance).toContain("enabled: enabled && canReadReversalSources");
    expect(governance).toContain("canReadReversalSources &&");
    expect(governance).toContain("canRequestReversal={canRequestReversal}");
    expect(governance).toContain("if (canReadReturnSources)");
    expect(governance).toContain("enabled: canReadSuppliers");
    expect(governance).toContain('me.data?.role === "admin"');
    expect(governance).toContain("canChooseBranch ? (");

    const returnComposer = readComponent("returns/ReturnComposer.tsx");
    expect(returnComposer).toContain('useOperationPermission("returns.create")');
    expect(returnComposer).toContain('useOperationPermission("refundRails.preflight")');
    expect(returnComposer).toContain("directExecution: executesImmediately");
    expect(returnComposer).toContain("refundRailPermission.allowed");
  });

  it("hides stock-expense tabs without the inventory adjustment operation", () => {
    const source = readPage("ExpenseNew.tsx");
    expect(source).toContain('"inventory.adjust"');
    expect(source).toContain('"catalog.forPurchase"');
    expect(source).toContain("canCreateExpense &&");
    expect(source).toContain("canLookupStockExpenseItems &&");
    expect(source).toContain("moduleAccessAllowed(");
    expect(source).toContain('me.data?.permissionsOverride ?? null');
    expect(source).toContain('setSource("CASH")');
  });

  it("enables sales returns for retail cashier, print cashier, and reception cashier while gating purchase returns and history", () => {
    const returnsHub = readPage("ReturnsHub.tsx");
    const requireRole = readComponent("RequireRole.tsx");
    const receptionQueue = readComponent("reception/ReceptionInvoiceQueue.tsx");
    const operationPolicy = (paths: string[]): OperationPolicy => ({
      version: 1,
      grants: Object.fromEntries(paths.map((path) => [`operation.${path}`, true])),
      dataVisibility: { purchaseCost: false, profitMargin: false },
    });

    expect(returnsHub).toContain('"returns.executeSalesReturnCart"');
    expect(returnsHub).toContain('"returns.executePurchaseReturnCart"');
    expect(returnsHub).toContain('useOperationPermission("returns.list").allowed');
    expect(returnsHub).toContain('"purchaseReturns.list"');
    expect(returnsHub).toContain("portalMode === \"purchases\" ? canExecutePurchaseReturn : canExecuteSalesReturn");
    expect(returnsHub).toContain("{canAccessPurchasePortal && (");
    expect(returnsHub).toContain("{canCreateActivePortal && (");
    expect(returnsHub).toContain("{canViewActiveHistory && (");

    expect(receptionQueue).toContain('row.sourceType === "WORKORDER" || parsedWorkOrderId != null');
    expect(receptionQueue).toContain("`/work-orders/${parsedWorkOrderId}`");

    expect(requireRole).toContain("canonicalGate === RETURNS_WORKSPACE_GATE");
    expect(requireRole).toContain("canSeeGate(RETURNS_ARCHIVE_GATE, role, override, operationPolicy)");
    expect(requireRole).toContain("canSeeGate(LEGACY_RETURNS_STATION_GATE, role, override, operationPolicy)");

    for (const role of ["cashier", "print_operator"] as const) {
      expect(
        canSeeGate(
          RETURNS_WORKSPACE_GATE,
          role,
          { pos: "FULL", sales: "NONE", workorders: "NONE" },
          operationPolicy([
            "returns.executeSalesReturnCart",
            "returns.inspectInvoiceForReturn",
            "returns.getOpenRefundDrawers",
            "returns.lookupItemForReturn",
            "returns.universalScan",
            "returns.forensicTrace",
          ]),
        ),
      ).toBe(true);
      expect(
        canSeeGate(
          RETURNS_WORKSPACE_GATE,
          role,
          { workorders: "FULL", pos: "READ", sales: "NONE" },
          operationPolicy([
            "returns.executeSalesReturnCart",
            "returns.inspectInvoiceForReturn",
            "returns.getOpenRefundDrawers",
            "returns.lookupItemForReturn",
            "returns.universalScan",
            "returns.forensicTrace",
          ]),
        ),
      ).toBe(true);
    }
  });
});

