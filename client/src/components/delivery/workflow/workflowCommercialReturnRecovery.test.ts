import { describe, expect, it } from "vitest";
import {
  clearWorkflowCommercial,
  chooseWorkflowCommercialRoute,
  parseWorkflowCommercialSnapshot,
  persistWorkflowCommercial,
  readWorkflowCommercial,
  workflowCommercialRoute,
  type WorkflowCommercialSnapshot,
} from "./workflowCommercialReturnRecovery";

const pending: WorkflowCommercialSnapshot = {
  version: 1,
  scope: { actorId: 5, branchId: 2, source: { kind: "consignment", id: 81 } },
  phase: "PENDING",
  memberIds: [81, 82],
  input: {
    consignmentId: 81,
    wholeShipment: true,
    refundShiftId: 71,
    returnReason: "استلمت كامل الشحنة وتقرر المرتجع التجاري",
    clientRequestId: "same-native-commercial-request",
  },
};
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
describe("native workflow commercial return recovery", () => {
  it("selects either granted route without overriding denial", () => {
    expect(chooseWorkflowCommercialRoute(true, false)).toBe("BARCODE");
    expect(chooseWorkflowCommercialRoute(false, true)).toBe("CONSIGNMENT");
    expect(chooseWorkflowCommercialRoute(true, true)).toBe("BARCODE");
    expect(chooseWorkflowCommercialRoute(false, false)).toBeNull();
  });
  it("preserves v1 native routing and refuses rerouting an uncertain v1 command", () => {
    const storage = memory();
    expect(persistWorkflowCommercial(storage, pending)).toBe(true);
    const old = readWorkflowCommercial(storage, pending.scope);
    expect(old.state === "SAVED" && workflowCommercialRoute(old.snapshot)).toBe(
      "CONSIGNMENT",
    );
    expect(
      persistWorkflowCommercial(storage, {
        ...pending,
        version: 2,
        route: "CONSIGNMENT",
      }),
    ).toBe(false);
    expect(
      clearWorkflowCommercial(storage, {
        ...pending,
        version: 2,
        route: "CONSIGNMENT",
      }),
    ).toBe(false);
  });
  it("keeps the actual barcode, full reviewed manifest, drawer and route immutable", () => {
    const storage = memory();
    const snapshot: WorkflowCommercialSnapshot = {
      version: 2,
      route: "BARCODE",
      scope: pending.scope,
      phase: "PENDING",
      consignmentId: 81,
      wholeShipment: true,
      memberIds: [81, 82],
      input: {
        barcode: "CN-2026-0081",
        returnReason: pending.input.returnReason,
        refundShiftId: 71,
        clientRequestId: "same-barcode-financial-return",
      },
    };
    expect(persistWorkflowCommercial(storage, snapshot)).toBe(true);
    expect(readWorkflowCommercial(storage, pending.scope)).toEqual({
      state: "SAVED",
      snapshot,
    });
    expect(
      persistWorkflowCommercial(storage, {
        ...pending,
        version: 2,
        route: "CONSIGNMENT",
      }),
    ).toBe(false);
    expect(
      persistWorkflowCommercial(storage, {
        ...snapshot,
        input: { ...snapshot.input, barcode: "CN-2026-0082" },
      }),
    ).toBe(false);
    expect(
      clearWorkflowCommercial(storage, { ...snapshot, memberIds: [81] }),
    ).toBe(false);
    expect(
      parseWorkflowCommercialSnapshot(
        JSON.stringify({
          ...snapshot,
          input: { ...snapshot.input, wholeShipment: true },
        }),
        pending.scope,
      ),
    ).toBeNull();
    const committed = { ...snapshot, phase: "COMMITTED" as const };
    expect(persistWorkflowCommercial(storage, committed)).toBe(true);
    expect(persistWorkflowCommercial(storage, snapshot)).toBe(false);
    expect(clearWorkflowCommercial(storage, committed)).toBe(true);
  });
  it("preserves exact whole-group, drawer, reason and key after lost reply/reload", () => {
    const storage = memory();
    expect(persistWorkflowCommercial(storage, pending)).toBe(true);
    expect(readWorkflowCommercial(storage, pending.scope)).toEqual({
      state: "SAVED",
      snapshot: pending,
    });
  });
  it("rejects actor/branch/source transplantation, hidden secrets and wrong full-group scope", () => {
    expect(
      parseWorkflowCommercialSnapshot(JSON.stringify(pending), {
        ...pending.scope,
        actorId: 6,
      }),
    ).toBeNull();
    expect(
      parseWorkflowCommercialSnapshot(JSON.stringify(pending), {
        ...pending.scope,
        branchId: 3,
      }),
    ).toBeNull();
    expect(
      parseWorkflowCommercialSnapshot(JSON.stringify(pending), {
        ...pending.scope,
        source: { kind: "invoice", id: 81 },
      }),
    ).toBeNull();
    for (const snapshot of [
      { ...pending, input: { ...pending.input, wholeShipment: false } },
      { ...pending, input: { ...pending.input, consignmentId: 90 } },
      {
        ...pending,
        input: { ...pending.input, providerSecret: "never-store" },
      },
    ])
      expect(
        parseWorkflowCommercialSnapshot(
          JSON.stringify(snapshot),
          pending.scope,
        ),
      ).toBeNull();
  });
  it("never replaces or clears another uncertain commercial intent", () => {
    const storage = memory();
    persistWorkflowCommercial(storage, pending);
    const changed = {
      ...pending,
      input: { ...pending.input, clientRequestId: "unsafe-new-attempt" },
    };
    expect(persistWorkflowCommercial(storage, changed)).toBe(false);
    expect(clearWorkflowCommercial(storage, changed)).toBe(false);
    expect(readWorkflowCommercial(storage, pending.scope)).toEqual({
      state: "SAVED",
      snapshot: pending,
    });
  });
  it("keeps known commit terminal across later refresh/storage cleanup failure", () => {
    const storage = memory();
    persistWorkflowCommercial(storage, pending);
    const committed = { ...pending, phase: "COMMITTED" as const };
    expect(persistWorkflowCommercial(storage, committed)).toBe(true);
    expect(persistWorkflowCommercial(storage, pending)).toBe(false);
    expect(
      clearWorkflowCommercial(
        {
          ...storage,
          removeItem: () => {
            throw new Error("blocked");
          },
        },
        committed,
      ),
    ).toBe(false);
    expect(readWorkflowCommercial(storage, pending.scope)).toEqual({
      state: "SAVED",
      snapshot: committed,
    });
    expect(clearWorkflowCommercial(storage, committed)).toBe(true);
  });
  it("fails closed if the durable write fails before the native RPC", () => {
    expect(
      persistWorkflowCommercial(
        {
          ...memory(),
          setItem: () => {
            throw new Error("quota");
          },
        },
        pending,
      ),
    ).toBe(false);
  });
});
