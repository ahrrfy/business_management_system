import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { treasuryOperationAllowed } from "./treasuryOperationAccess";
import { canSeeGate } from "./navVisibility";
import { resolvePermissions } from "@shared/permissions";
import {
  OPERATION_PERMISSIONS,
  getOperationPermission,
  resolveOperationPolicy,
  type OperationUser,
} from "@shared/operationPermissions";

const user = (paths: string[], role = "warehouse"): OperationUser => ({
  role,
  operationPolicyEnabled: true,
  resolvedOperationPolicy: {
    version: 1,
    grants: Object.fromEntries(paths.map((path) => [`operation.${path}`, true])),
  },
});

describe("treasury exact operation display authority", () => {
  it("waits for the profile and preserves untouched legacy decisions", () => {
    expect(treasuryOperationAllowed(undefined, "cashTransfers.send", true)).toBe(false);
    expect(treasuryOperationAllowed({ role: "manager" }, "cashTransfers.send", true)).toBe(true);
    expect(treasuryOperationAllowed({ role: "manager" }, "cashTransfers.send", false)).toBe(false);
  });

  it("does not activate migration from a compatibility snapshot alone", () => {
    const profile = user(["cashTransfers.send"]);
    delete profile.operationPolicyEnabled;
    expect(treasuryOperationAllowed(profile, "cashTransfers.send", false)).toBe(false);
  });

  it("allows a delegated specialist despite a legacy role denial", () => {
    expect(treasuryOperationAllowed(user(["expenses.create"]), "expenses.create", false)).toBe(true);
  });

  it("revokes a manager action without an inherited module bypass", () => {
    expect(treasuryOperationAllowed(user([], "manager"), "expenses.executeManaged", true)).toBe(false);
  });

  it("keeps sending, receiving and cancellation independent", () => {
    const profile = user(["cashTransfers.receive"]);
    expect(treasuryOperationAllowed(profile, "cashTransfers.receive", false)).toBe(true);
    expect(treasuryOperationAllowed(profile, "cashTransfers.send", true)).toBe(false);
    expect(treasuryOperationAllowed(profile, "cashTransfers.cancel", true)).toBe(false);
  });

  it("keeps rejection independent from approval and evidence registration", () => {
    const profile = user(["treasury.cashVariance.reject"]);
    expect(treasuryOperationAllowed(profile, "treasury.cashVariance.reject", false)).toBe(true);
    expect(treasuryOperationAllowed(profile, "treasury.cashVariance.approve", true)).toBe(false);
    expect(treasuryOperationAllowed(profile, "treasury.cashVariance.registerEvidence", true)).toBe(false);
  });

  it("honors a sparse user denial without changing the shared role", () => {
    const rolePolicy = { version: 1 as const, grants: { "operation.vouchers.cancel": true } };
    const userPolicy = { version: 1 as const, grants: { "operation.vouchers.cancel": false } };
    const profile = {
      role: "manager",
      roleOperationPolicy: rolePolicy,
      operationPolicy: userPolicy,
      resolvedOperationPolicy: resolveOperationPolicy("manager", resolvePermissions("manager", null), rolePolicy, userPolicy),
    };
    expect(treasuryOperationAllowed(profile, "vouchers.cancel", true)).toBe(false);
    expect(rolePolicy.grants["operation.vouchers.cancel"]).toBe(true);
  });

  it("preserves owner authority and fails closed on an unknown path", () => {
    const owner = { ...user([]), isOwner: true };
    expect(treasuryOperationAllowed(owner, "treasury.fundTreasury", false)).toBe(true);
    expect(treasuryOperationAllowed(owner, "treasury.nonexistent", true)).toBe(false);
  });

  it("requires explicit cost visibility for a cost-bearing report", () => {
    const report = OPERATION_PERMISSIONS.find((operation) => operation.delegable && operation.requiresCostVisibility);
    expect(report).toBeDefined();
    const profile = user([report!.path]);
    expect(treasuryOperationAllowed(profile, report!.path, true)).toBe(false);
    profile.resolvedOperationPolicy!.dataVisibility = { purchaseCost: true, profitMargin: true };
    expect(treasuryOperationAllowed(profile, report!.path, false)).toBe(true);
  });

  it("keeps a cancellation grant from opening an unrelated treasury list tab", () => {
    const policy = user(["cashTransfers.cancel"]).resolvedOperationPolicy!;
    expect(canSeeGate({ module: "treasury", operations: ["vouchers.list"] }, "manager", null, policy)).toBe(false);
    expect(canSeeGate({ module: "treasury", operations: ["cashTransfers.cancel"] }, "warehouse", null, policy)).toBe(true);
  });

  it("requires both daily report read capabilities for the combined page", () => {
    const gate = { allOf: [{ operations: ["reports.dayCloseReconciliation"] }, { operations: ["treasury.dailyCashReconciliation"] }] };
    expect(canSeeGate(gate, "warehouse", null, user(["treasury.dailyCashReconciliation"]).resolvedOperationPolicy)).toBe(false);
    expect(canSeeGate(gate, "warehouse", null, user(["treasury.dailyCashReconciliation", "reports.dayCloseReconciliation"]).resolvedOperationPolicy)).toBe(true);
  });

  it("binds treasury UI literal operations to real catalog entries", () => {
    for (const file of [
      "../pages/Treasury.tsx", "../pages/TreasuryHub.tsx", "../pages/TreasuryTransfers.tsx",
      "../pages/DayCloseReport.tsx", "../pages/Expenses.tsx", "../pages/ExpenseNew.tsx",
      "../pages/Vouchers.tsx", "../pages/Shifts.tsx", "../pages/ExpenseCategories.tsx",
      "../pages/VoucherCategories.tsx", "../components/treasury/CashVarianceResolutionPanel.tsx",
      "../components/cash/MissedDailyCountExceptionPanel.tsx", "../components/expenses/ExpenseCorrectionDialog.tsx",
      "../components/expenses/ExpenseTracePanel.tsx", "../components/expenses/ExpenseMobileCard.tsx",
      "../components/vouchers/VoucherFormShared.tsx",
      "../components/vouchers/useVoucherFormState.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const paths = [...source.matchAll(/treasuryOperationAllowed\([^,]+,\s*"([^"]+)"/g)].map((match) => match[1]!);
      for (const match of source.matchAll(/operations:\s*\[([^\]]+)\]/g)) {
        paths.push(...[...match[1]!.matchAll(/"([^"]+)"/g)].map((path) => path[1]!));
      }
      for (const path of paths) expect(getOperationPermission(path), `${file}: ${path}`).toBeDefined();
    }
    const voucherForm = readFileSync(new URL("../components/vouchers/VoucherFormShared.tsx", import.meta.url), "utf8");
    const voucherModel = readFileSync(new URL("../components/vouchers/useVoucherForm.ts", import.meta.url), "utf8");
    const voucherState = readFileSync(new URL("../components/vouchers/useVoucherFormState.ts", import.meta.url), "utf8");
    expect(voucherForm).toContain('import { useVoucherForm } from "./useVoucherForm";');
    expect(voucherForm).toContain("const model = useVoucherForm(props)");
    expect(voucherModel).toContain("const state = useVoucherFormState(props)");
    expect(voucherModel).toContain("return { ...state, ...queries, ...submission, ...ledger }");
    expect(voucherState).toContain('treasuryOperationAllowed(me.data, "vouchers.create", true)');
    expect(voucherForm).toContain("!canCreate || create.isPending || hardBlock");
  });
});
