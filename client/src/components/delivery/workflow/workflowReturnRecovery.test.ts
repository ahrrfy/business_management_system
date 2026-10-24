import { describe, expect, it } from "vitest";
import {
  clearWorkflowReturnSnapshot,
  definitiveWorkflowReturnRejection,
  parseWorkflowReturnSnapshot,
  persistWorkflowReturnSnapshot,
  readWorkflowReturnRecovery,
  workflowReturnStorageKey,
  type WorkflowReturnScope,
  type WorkflowReturnSnapshot,
} from "./workflowReturnRecovery";

const scope: WorkflowReturnScope = {
  actorId: 7,
  branchId: 2,
  source: { kind: "invoice", id: 19 },
};
const pending: WorkflowReturnSnapshot = {
  version: 2,
  scope,
  phase: "PENDING",
  savedAt: 100,
  command: {
    action: "receive",
    input: {
      source: {
        ...scope.source,
        expectedVersion: "original-source-version-token",
      },
      branchId: scope.branchId,
      evidence: "استلمت الطرد وفحصته فعلياً",
      inspected: true,
      clientRequestId: "stable-original-request-001",
    },
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

describe("workflow return durable command recovery", () => {
  it("compares validated command values independently of object key order", () => {
    const storage = memory();
    persistWorkflowReturnSnapshot(storage, pending);
    if (pending.command.action !== "receive")
      throw new Error("physical fixture required");
    const input = pending.command.input;
    const reordered: WorkflowReturnSnapshot = {
      ...pending,
      phase: "COMMITTED",
      command: {
        action: "receive",
        input: {
          clientRequestId: input.clientRequestId,
          inspected: input.inspected,
          evidence: input.evidence,
          branchId: input.branchId,
          source: input.source,
        },
      },
    };
    expect(persistWorkflowReturnSnapshot(storage, reordered)).toBe(true);
    expect(clearWorkflowReturnSnapshot(storage, reordered)).toBe(true);
  });
  it("restores exact physical source version, evidence and request key after reload", () => {
    const storage = memory();
    expect(persistWorkflowReturnSnapshot(storage, pending)).toBe(true);
    expect(readWorkflowReturnRecovery(storage, scope)).toEqual({
      state: "SAVED",
      snapshot: pending,
    });
    expect(persistWorkflowReturnSnapshot(storage, pending)).toBe(true);
  });
  it("isolates actor, branch and source and refuses transplanted envelopes", () => {
    const raw = JSON.stringify(pending);
    for (const foreign of [
      { ...scope, actorId: 8 },
      { ...scope, branchId: 3 },
      { ...scope, source: { kind: "invoice" as const, id: 20 } },
    ]) {
      expect(workflowReturnStorageKey(foreign)).not.toBe(
        workflowReturnStorageKey(scope),
      );
      expect(parseWorkflowReturnSnapshot(raw, foreign)).toBeNull();
    }
    const declared = {
      ...pending,
      command: {
        action: "declare",
        input: {
          action: "declareReturn",
          source: {
            kind: "invoice",
            id: 20,
            expectedVersion: "old-source-version",
          },
          reason: "سبب موثق",
          branchId: 2,
          clientRequestId: "stable-original-request-001",
        },
      },
    };
    expect(
      parseWorkflowReturnSnapshot(JSON.stringify(declared), scope),
    ).toBeNull();
  });
  it("fails closed for malformed data, unknown fields and payment provider secrets", () => {
    for (const value of [
      "{broken",
      JSON.stringify({ ...pending, version: 3 }),
      JSON.stringify({
        ...pending,
        command: {
          ...pending.command,
          input: {
            ...pending.command.input,
            providerSecret: "must-never-be-persisted",
          },
        },
      }),
    ])
      expect(parseWorkflowReturnSnapshot(value, scope)).toBeNull();
    const storage = memory();
    storage.setItem(workflowReturnStorageKey(scope), "broken");
    expect(readWorkflowReturnRecovery(storage, scope)).toEqual({
      state: "INVALID",
    });
    expect(persistWorkflowReturnSnapshot(storage, pending)).toBe(false);
  });
  it("never reinterprets a saved legacy sale-reversal/refund as a new physical receipt", () => {
    const storage = memory();
    const legacy = {
      ...pending,
      version: 1,
      command: {
        action: "receive",
        input: {
          barcode: "CN-2-001",
          returnReason: "رد قديم قد يشمل البيع والمال",
          refundShiftId: 42,
          clientRequestId: pending.command.input.clientRequestId,
        },
      },
    };
    storage.setItem(
      workflowReturnStorageKey(scope).replace(":v2:", ":v1:"),
      JSON.stringify(legacy),
    );
    expect(readWorkflowReturnRecovery(storage, scope)).toEqual({
      state: "LEGACY",
    });
    expect(persistWorkflowReturnSnapshot(storage, pending)).toBe(false);
    expect(
      parseWorkflowReturnSnapshot(JSON.stringify(legacy), scope),
    ).toBeNull();
    expect(
      parseWorkflowReturnSnapshot(
        JSON.stringify({
          ...pending,
          command: {
            ...pending.command,
            input: { ...pending.command.input, inspected: false },
          },
        }),
        scope,
      ),
    ).toBeNull();
  });
  it("retains the exact inspected group subset and rejects duplicated member identities", () => {
    if (pending.command.action !== "receive")
      throw new Error("physical fixture required");
    const subset: WorkflowReturnSnapshot = {
      ...pending,
      command: {
        action: "receive",
        input: { ...pending.command.input, receivedConsignmentIds: [81, 83] },
      },
    };
    const storage = memory();
    expect(persistWorkflowReturnSnapshot(storage, subset)).toBe(true);
    expect(readWorkflowReturnRecovery(storage, scope)).toEqual({
      state: "SAVED",
      snapshot: subset,
    });
    expect(
      parseWorkflowReturnSnapshot(
        JSON.stringify({
          ...subset,
          command: {
            ...subset.command,
            input: {
              ...subset.command.input,
              receivedConsignmentIds: [81, 81],
            },
          },
        }),
        scope,
      ),
    ).toBeNull();
  });
  it("does not replace or clear another unresolved command", () => {
    const storage = memory();
    expect(persistWorkflowReturnSnapshot(storage, pending)).toBe(true);
    const different = {
      ...pending,
      command: {
        ...pending.command,
        input: {
          ...pending.command.input,
          clientRequestId: "a-new-key-would-be-unsafe",
        },
      },
    } as WorkflowReturnSnapshot;
    expect(persistWorkflowReturnSnapshot(storage, different)).toBe(false);
    expect(clearWorkflowReturnSnapshot(storage, different)).toBe(false);
    expect(readWorkflowReturnRecovery(storage, scope)).toEqual({
      state: "SAVED",
      snapshot: pending,
    });
  });
  it("retains known commit state across refresh failure or reload and clears only its exact command", () => {
    const storage = memory();
    persistWorkflowReturnSnapshot(storage, pending);
    const committed = { ...pending, phase: "COMMITTED" as const };
    expect(persistWorkflowReturnSnapshot(storage, committed)).toBe(true);
    expect(persistWorkflowReturnSnapshot(storage, pending)).toBe(false);
    expect(readWorkflowReturnRecovery(storage, scope)).toEqual({
      state: "SAVED",
      snapshot: committed,
    });
    expect(clearWorkflowReturnSnapshot(storage, committed)).toBe(true);
    expect(readWorkflowReturnRecovery(storage, scope)).toEqual({
      state: "EMPTY",
    });
  });
  it("refuses execution if durable storage fails and separates backend rejection from unknown transport", () => {
    const storage = {
      ...memory(),
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(persistWorkflowReturnSnapshot(storage, pending)).toBe(false);
    expect(definitiveWorkflowReturnRejection(new Error("transport lost"))).toBe(
      false,
    );
    expect(
      definitiveWorkflowReturnRejection({
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
    ).toBe(false);
    expect(
      definitiveWorkflowReturnRejection({ data: { code: "CONFLICT" } }),
    ).toBe(true);
  });
});
