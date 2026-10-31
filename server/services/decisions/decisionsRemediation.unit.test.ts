import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  getOperationPermission,
  operationDecision,
} from "@shared/operationPermissions";
const inboxState = vi.hoisted(() => ({ current: vi.fn(), db: vi.fn() }));
vi.mock("../authorization/operationAuthority", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../authorization/operationAuthority")
  >()),
  loadOperationUserTx: inboxState.current,
}));
vi.mock("../tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tx")>()),
  withTx: async (run: (tx: never) => Promise<unknown>) => run({} as never),
  requireDb: inboxState.db,
}));
import { storedOperationUser } from "../authorization/operationAuthority";
import {
  DECISION_OPERATION_PATHS,
  currentDecisionActor,
  sourceAuthorityPasses,
} from "./authority";
import type { DecisionActor, DecisionSource } from "./types";
import { DECISION_SOURCE_CONTINUATIONS } from "./continuation";
import { listDecisionInbox } from "./index";
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

describe("cost-wave inbox data visibility", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  const wave = {
    id: 91,
    name: "Sensitive cost correction",
    purpose: "CORRECTION",
    ruleType: "SET_COST",
    changeValue: "125.00",
    expectedValueDelta: "250.00",
    inventoryValueBefore: "1000.00",
    inventoryValueAfter: "1250.00",
    branchId: 1,
    createdBy: 7,
    createdAt: now,
    itemCount: 1,
    skippedCount: 0,
    expectedQuantity: 10,
    approvalCount: 0,
    reason: "Saved cost evidence",
  };
  beforeEach(() => {
    inboxState.current.mockReset();
    inboxState.db.mockReset();
    inboxState.db.mockImplementation(() => ({
      select: () => {
        let tableName = "";
        const query = {
          from: (table: Parameters<typeof getTableName>[0]) => {
            tableName = getTableName(table);
            return query;
          },
          leftJoin: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              tableName === "costUpdateWaves"
                ? [{ wave, createdByName: "Maker" }]
                : tableName === "branches"
                  ? [{ id: 1, name: "Branch" }]
                  : [],
            ).then(resolve),
        };
        return query;
      },
    }));
  });
  function reviewer(
    action: "APPROVE" | "REJECT" | null,
    purchaseCost: boolean,
    profitMargin: boolean,
    owner = false,
  ) {
    const current = storedOperationUser({
      id: actor.userId,
      role: "manager",
      isActive: true,
      isOwner: owner,
      customRoleId: null,
      branchId: 1,
      permissionsOverride: { inventory: "NONE" },
      operationPolicy: {
        version: 1,
        grants: {
          "operation.inventory.approveCostWave": action === "APPROVE",
          "operation.inventory.rejectCostWave": action === "REJECT",
          "operation.inventory.costWaves": false,
        },
        dataVisibility: { purchaseCost, profitMargin: purchaseCost },
      },
    });
    // Persisted policies require equal flags. Exercise each resolved snapshot
    // field independently so changing the projection guard from OR to AND fails.
    return purchaseCost === profitMargin
      ? current
      : {
          ...current,
          resolvedOperationPolicy: {
            ...current.resolvedOperationPolicy!,
            dataVisibility: { purchaseCost, profitMargin },
          },
        };
  }
  const inbox = () =>
    listDecisionInbox(actor, { kind: "inventory.costWave.approve", now });
  it.each([
    ["APPROVE", false, false],
    ["REJECT", false, false],
    ["APPROVE", false, true],
    ["APPROVE", true, false],
    ["REJECT", false, true],
    ["REJECT", true, false],
  ] as const)(
    "withholds all wave fields for %s with cost=%s profit=%s",
    async (action, cost, profit) => {
      inboxState.current.mockResolvedValue(reviewer(action, cost, profit));
      const result = await inbox();
      expect(result.rows).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.truncatedSources).toEqual([]);
      expect(result.failedSources).toEqual([]);
      expect(inboxState.db).not.toHaveBeenCalled();
    },
  );
  it.each(["APPROVE", "REJECT"] as const)(
    "retains cost-visible %s discovery without the list grant",
    async (action) => {
      const currentUser = reviewer(action, true, true);
      expect(
        operationDecision(currentUser, "inventory.costWaves").allowed,
      ).toBe(false);
      inboxState.current.mockResolvedValue(currentUser);
      const result = await inbox();
      expect(result.failedSources).toEqual([]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        id: wave.id,
        title: `موجة تكلفة · ${wave.name}`,
        amount: wave.expectedValueDelta,
        reason: wave.reason,
        allowedActions: [action],
        summaryItems: expect.arrayContaining([
          expect.objectContaining({ qty: wave.changeValue }),
          expect.objectContaining({ unitPrice: wave.inventoryValueBefore }),
          expect.objectContaining({ unitPrice: wave.inventoryValueAfter }),
        ]),
      });
    },
  );
  it("does not discover waves from cost visibility alone", async () => {
    inboxState.current.mockResolvedValue(reviewer(null, true, true));
    expect((await inbox()).rows).toEqual([]);
    expect(inboxState.db).not.toHaveBeenCalled();
  });
  it("preserves owner discovery despite explicit visibility and action denials", async () => {
    inboxState.current.mockResolvedValue(reviewer(null, false, false, true));
    const result = await inbox();
    expect(result.failedSources).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amount: wave.expectedValueDelta,
      allowedActions: ["APPROVE", "REJECT"],
    });
  });
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
