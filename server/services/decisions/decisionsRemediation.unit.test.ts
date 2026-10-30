import { describe, expect, it } from "vitest";
import { getOperationPermission } from "@shared/operationPermissions";
import { storedOperationUser } from "../authorization/operationAuthority";
import {
  DECISION_OPERATION_PATHS,
  currentDecisionActor,
  sourceAuthorityPasses,
} from "./authority";
import type { DecisionActor, DecisionSource } from "./types";
import { DECISION_SOURCE_CONTINUATIONS } from "./continuation";
const actor: DecisionActor = {
  userId: 42,
  role: "manager",
  isOwner: false,
  branchId: 1,
  crossBranch: false,
  permissionsOverride: null,
};
const source = (key: string, gate: DecisionSource["gate"]): DecisionSource => ({
  key,
  kinds: [],
  gate,
  supportedActions: ["APPROVE", "REJECT"],
  list: async () => [],
  freshness: async () => "PENDING",
  decide: async () => {
    throw new Error("not used");
  },
});
function current(
  grants: Record<string, boolean>,
  overrides: Record<string, "NONE" | "FULL"> = {},
  owner = false,
  branchId: number | null = 1,
) {
  return currentDecisionActor(
    actor,
    storedOperationUser({
      id: 42,
      role: "manager",
      isOwner: owner,
      isActive: true,
      customRoleId: null,
      branchId,
      permissionsOverride: overrides,
      operationPolicy: { version: 1, grants },
    }),
  );
}
describe("decisions remediation canonical source authority", () => {
  it("uses explicit source-list continuations without fake document IDs", () => {
    expect(Object.keys(DECISION_SOURCE_CONTINUATIONS)).toHaveLength(19);
    for (const href of Object.values(DECISION_SOURCE_CONTINUATIONS)) {
      expect(href).not.toMatch(/\/0(?:\?|$)|(?:Id|wave)=0(?:&|$)/);
      expect(href).toMatch(/^\//);
    }
  });
  it("maps every declared operation to the existing catalog", () => {
    for (const [key, actions] of Object.entries(DECISION_OPERATION_PATHS)) {
      expect(Object.keys(actions).length, key).toBeGreaterThan(0);
      for (const paths of Object.values(actions))
        for (const path of paths ?? [])
          expect(getOperationPermission(path), `${key}: ${path}`).toBeDefined();
    }
  });
  it("does not borrow a generic decision grant after an underlying operation denial", () => {
    const s = source("purchase.order.control", {
      type: "MODULE",
      moduleKey: "purchases",
      roles: ["manager", "purchasing"],
    });
    expect(
      sourceAuthorityPasses(
        s,
        current(
          {
            "operation.decisions.decide": true,
            "operation.purchases.decideControl": false,
          },
          { purchases: "FULL" },
        ),
        "APPROVE",
      ),
    ).toBe(false);
  });
  it("discovers explicit operation delegation despite legacy module NONE", () => {
    const s = source("purchase.order.control", {
      type: "MODULE",
      moduleKey: "purchases",
      roles: ["manager", "purchasing"],
    });
    expect(
      sourceAuthorityPasses(
        s,
        current(
          { "operation.purchases.decideControl": true },
          { purchases: "NONE" },
        ),
        "APPROVE",
      ),
    ).toBe(true);
    expect(
      sourceAuthorityPasses(
        s,
        current(
          { "operation.purchases.decideControl": true },
          { purchases: "NONE" },
          false,
          null,
        ),
        "APPROVE",
      ),
    ).toBe(false);
  });
  it("separates approve/reject paths and preserves fixed owner authority", () => {
    const s = source("inventory.adjustment", {
      type: "MODULE",
      moduleKey: "inventory",
      roles: ["manager"],
    });
    const a = current(
      {
        "operation.inventory.approveAdjustment": false,
        "operation.inventory.rejectAdjustment": true,
      },
      { inventory: "NONE" },
    );
    expect(sourceAuthorityPasses(s, a)).toBe(true);
    expect(sourceAuthorityPasses(s, a, "APPROVE")).toBe(false);
    expect(sourceAuthorityPasses(s, a, "REJECT")).toBe(true);
    const voucher = source("treasury.voucher", {
      type: "OWNER",
      moduleKey: "treasury",
    });
    expect(
      sourceAuthorityPasses(
        voucher,
        current({ "operation.vouchers.approve": true }, { treasury: "FULL" }),
        "APPROVE",
      ),
    ).toBe(false);
    expect(
      sourceAuthorityPasses(voucher, current({}, {}, true), "APPROVE"),
    ).toBe(true);
  });
});
