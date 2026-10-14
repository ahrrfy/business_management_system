import { describe, expect, it } from "vitest";
import { hasOperationPolicy, operationDecision, type OperationPolicy } from "@shared/operationPermissions";
import { storedOperationUser } from "../authorization/operationAuthority";
import { isPotentialCashCustodyRecipient, type CashCustodyVisibilityActor } from "../cash/custodyBlindCount";

const source = { branchId: 3, handedOverByUserId: 1, shiftOwnerUserId: 2 };
const acceptanceKey = "operation.treasury.acceptHandoverReceipt";

function currentActor(role: string, operationPolicy: OperationPolicy | null): CashCustodyVisibilityActor {
  const user = storedOperationUser({
    id: 4, role, branchId: 3, isActive: true, isOwner: false, customRoleId: null,
    permissionsOverride: null, operationPolicy,
  });
  return {
    userId: 4, role: user.role, branchId: 3,
    operationPolicyEnabled: hasOperationPolicy(user),
    canAcceptHandover: operationDecision(user, "treasury.acceptHandoverReceipt").allowed,
  };
}

describe("blind-count privacy follows the actual current acceptance authority", () => {
  it("protects a delegated warehouse receiver who also has movement visibility", () => {
    const actor = currentActor("warehouse", { version: 1, grants: {
      [acceptanceKey]: true, "operation.treasury.getRecentMovements": true,
    } });
    expect(isPotentialCashCustodyRecipient(actor, source)).toBe(true);
  });

  it("does not infer receiver eligibility from an unrelated movement grant", () => {
    const actor = currentActor("warehouse", { version: 1, grants: {
      [acceptanceKey]: false, "operation.treasury.getRecentMovements": true,
    } });
    expect(isPotentialCashCustodyRecipient(actor, source)).toBe(false);
  });

  it("honors an individual acceptance denial even for a manager", () => {
    const actor = currentActor("manager", { version: 1, grants: { [acceptanceKey]: false } });
    expect(isPotentialCashCustodyRecipient(actor, source)).toBe(false);
  });

  it.each(["admin", "manager"])("preserves the legacy %s receiver protection", (role) => {
    expect(isPotentialCashCustodyRecipient(currentActor(role, null), source)).toBe(true);
  });

  it("preserves the legacy warehouse restriction", () => {
    expect(isPotentialCashCustodyRecipient(currentActor("warehouse", null), source)).toBe(false);
  });

  it.each([
    { userId: 1 },
    { userId: 2 },
    { branchId: 8 },
    { branchId: null },
  ])("retains custody identity and branch exclusions for %j", (identity) => {
    const actor = currentActor("warehouse", { version: 1, grants: { [acceptanceKey]: true } });
    expect(isPotentialCashCustodyRecipient({ ...actor, ...identity }, source)).toBe(false);
  });

  it("requires a real source branch for the privacy match", () => {
    const actor = currentActor("warehouse", { version: 1, grants: { [acceptanceKey]: true } });
    expect(isPotentialCashCustodyRecipient(actor, { ...source, branchId: null })).toBe(false);
  });

  it("does not use the old manager shortcut when a canonical decision is absent", () => {
    expect(isPotentialCashCustodyRecipient({
      userId: 4, role: "manager", branchId: 3, operationPolicyEnabled: true,
    }, source)).toBe(false);
  });

  it("does not activate canonical eligibility without the internal enabled flag", () => {
    expect(isPotentialCashCustodyRecipient({
      userId: 4, role: "warehouse", branchId: 3, canAcceptHandover: true,
    }, source)).toBe(false);
  });
});
