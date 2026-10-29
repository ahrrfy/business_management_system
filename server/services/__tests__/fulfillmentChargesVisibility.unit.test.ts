import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type Table } from "drizzle-orm";
import type { Tx } from "../../db";
import type { StoredOperationSnapshot } from "../authorization/operationAuthority";
import type { OperationPolicy } from "@shared/operationPermissions";

const state = vi.hoisted(() => ({
  tx: null as Tx | null,
  current: null as StoredOperationSnapshot | null,
  replay: null as number | null,
  charge: {
    id: 7,
    branchId: 1,
    requestId: null,
    customerId: 9,
    category: "OUTSOURCED",
    status: "APPROVED",
    description: "خدمة تعهيد",
    amount: "5000.00",
    externalCost: "3000.00",
    paidAmount: "1000.00",
    refundedAmount: "0.00",
    payeePaidAmount: "750.00",
    payeeSupplierId: 2,
    payeePartyId: null,
    payeeUserId: null,
    payeeName: null,
    payeePhone: null,
    approvedBy: 2,
    createdBy: 1,
    version: 3,
    clientRequestId: "original-key",
    sourceHash: "source",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
}));
vi.mock("../tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tx")>()),
  withTx: async (fn: (tx: Tx) => Promise<unknown>) => fn(state.tx!),
}));
vi.mock("../authorization/operationAuthority", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../authorization/operationAuthority")
    >();
  return {
    ...original,
    loadOperationUserTx: vi.fn(async () => state.current!),
    assertOperationAuthorityTx: vi.fn(
      async (
        _tx: Tx,
        _actor: unknown,
        path: string,
        legacy: boolean | ((current: StoredOperationSnapshot) => boolean),
      ) => {
        const allowed =
          original.storedCanonicalOperationAllowed(state.current!, path) ??
          (typeof legacy === "function" ? legacy(state.current!) : legacy);
        if (!allowed)
          throw Object.assign(new Error("operation forbidden"), {
            code: "FORBIDDEN",
          });
        return true;
      },
    ),
  };
});
vi.mock("../fulfillment/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fulfillment/core")>()),
  loadFulfillmentChargeTx: vi.fn(async () => ({ ...state.charge })),
  findFulfillmentReplayTx: vi.fn(async () => state.replay),
}));

import { storedOperationUser } from "../authorization/operationAuthority";
import {
  getFulfillmentCharge,
  listFulfillmentCharges,
} from "../fulfillment/chargeQueries";
import {
  approveFulfillmentCharge,
  collectFulfillmentCharges,
  completeFulfillmentCharge,
  createFulfillmentCharge,
  settleFulfillmentChargePayee,
} from "../fulfillment/charges";

const reads = {
  "operation.delivery.fulfillment.charges.list": true,
  "operation.delivery.fulfillment.charges.get": true,
  "operation.delivery.fulfillment.charges.create": true,
  "operation.delivery.fulfillment.charges.approve": true,
  "operation.delivery.fulfillment.charges.complete": true,
  "operation.delivery.fulfillment.charges.collect": true,
  "operation.delivery.fulfillment.charges.settlePayee": true,
};
const hiddenPolicy: OperationPolicy = {
  version: 1,
  grants: reads,
  dataVisibility: { purchaseCost: false, profitMargin: false },
};
function current(
  role: string,
  options: {
    owner?: boolean;
    policy?: OperationPolicy;
    reportsNone?: boolean;
  } = {},
) {
  state.current = storedOperationUser({
    id: 4,
    role,
    isActive: true,
    isOwner: options.owner ?? false,
    customRoleId: null,
    branchId: 1,
    permissionsOverride: options.reportsNone ? { reports: "NONE" } : null,
    operationPolicy: options.policy ?? null,
  });
  return { userId: 4, branchId: 1, role: options.owner ? "admin" : role };
}
beforeEach(() => {
  state.current = null;
  state.replay = null;
  const select = vi.fn((selection?: Record<string, unknown>) => {
    let table = "";
    const query: Record<string, unknown> = {
      from: (value: Table) => {
        table = getTableName(value);
        return query;
      },
      where: () => query,
      for: () => query,
      limit: () => query,
      offset: () => query,
      orderBy: () => query,
      leftJoin: () => query,
      then: (
        resolve: (rows: unknown[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => {
        const rows =
          table === "fulfillmentCharges"
            ? selection && "total" in selection
              ? [{ total: 1 }]
              : [
                  {
                    charge: { ...state.charge },
                    customerName: "عميل",
                    requestNumber: null,
                  },
                ]
            : table === "fulfillmentChargePayments"
              ? [
                  {
                    payment: { id: 1, kind: "COLLECTION", amount: "1000.00" },
                    receipt: {
                      id: 10,
                      amount: "1000.00",
                      paymentMethod: "CASH",
                      internalNote: null,
                    },
                  },
                  {
                    payment: { id: 2, kind: "PAYEE_PAYMENT", amount: "750.00" },
                    receipt: {
                      id: 20,
                      amount: "750.00",
                      paymentMethod: "CASH",
                      internalNote: "private payee proof",
                    },
                  },
                ]
              : table === "customers"
                ? [{ id: 9, name: "عميل", phone: "+9647701234567" }]
                : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return query;
  });
  const unexpected = () => {
    throw new Error("Unexpected financial write");
  };
  state.tx = {
    select,
    insert: vi.fn(unexpected),
    update: vi.fn(unexpected),
  } as unknown as Tx;
});

describe("fulfillment charge cost response authority", () => {
  it.each([
    ["default cashier", "cashier", {}, false],
    [
      "delegated cashier with visibility revoked",
      "cashier",
      { policy: hiddenPolicy },
      false,
    ],
    ["manager with reports NONE", "manager", { reportsNone: true }, false],
    ["owner", "admin", { owner: true }, true],
  ] as const)(
    "projects list/get for %s",
    async (_label, role, options, visible) => {
      const actor = current(role, options);
      const list = await listFulfillmentCharges({ branchId: 1 }, actor),
        detail = await getFulfillmentCharge(7, actor);
      expect(list.costVisible).toBe(visible);
      expect(detail.costVisible).toBe(visible);
      for (const row of [list.rows[0], detail.charge]) {
        expect(row.externalCost).toBe(visible ? "3000.00" : null);
        expect(row.payeePaidAmount).toBe(visible ? "750.00" : null);
        expect(row.amount).toBe("5000.00");
        expect(row.paidAmount).toBe("1000.00");
      }
      expect(list.rows[0].payeeRemaining).toBe(visible ? "2250.00" : null);
      expect(detail.payeeRemaining).toBe(visible ? "2250.00" : null);
      expect(detail.remainingAmount).toBe("4000.00");
      expect(detail.payments.map((p) => p.payment.kind)).toEqual(
        visible ? ["COLLECTION", "PAYEE_PAYMENT"] : ["COLLECTION"],
      );
      if (!visible) {
        expect(JSON.stringify(detail)).not.toContain("private payee proof");
        expect(JSON.stringify(detail)).not.toContain("750.00");
        expect(JSON.stringify(detail)).not.toContain("3000.00");
      }
    },
  );
  it("reads current visibility rather than accepting actor owner flags", async () => {
    const actor = current("cashier", { policy: hiddenPolicy });
    expect(
      (await getFulfillmentCharge(7, { ...actor, isOwner: true })).charge
        .externalCost,
    ).toBeNull();
    current("cashier", {
      policy: {
        ...hiddenPolicy,
        dataVisibility: { purchaseCost: true, profitMargin: true },
      },
    });
    expect((await getFulfillmentCharge(7, actor)).charge.externalCost).toBe(
      "3000.00",
    );
  });
  it.each(["cashier", "manager"])(
    "blocks blind approval and payee settlement, including replay, for %s",
    async (role) => {
      const actor = current(role, { policy: hiddenPolicy });
      state.replay = 99;
      const identity = {
        id: 7,
        expectedVersion: 3,
        clientRequestId: "replay-current-authority",
      };
      await expect(
        approveFulfillmentCharge(identity, actor),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        settleFulfillmentChargePayee(
          {
            ...identity,
            amount: "750",
            tender: { method: "CASH", cashBucket: "DRAWER", shiftId: 1 },
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(state.tx!.insert).not.toHaveBeenCalled();
      expect(state.tx!.update).not.toHaveBeenCalled();
    },
  );
  it("redacts a create replay's later internal cost/payment values while retaining source identity", async () => {
    const actor = current("cashier", { policy: hiddenPolicy });
    state.replay = 7;
    const row = await createFulfillmentCharge(
      {
        branchId: 1,
        customerId: 9,
        category: "SERVICE",
        description: "عرض كتبه المستخدم",
        amount: "5000",
        externalCost: "0",
        clientRequestId: "create-source-replay",
      },
      actor,
    );
    expect(row).toMatchObject({
      id: 7,
      externalCost: null,
      payeePaidAmount: null,
    });
    expect(state.tx!.insert).not.toHaveBeenCalled();
  });
  it("retains an owner's approved-source replay and existing settlement result", async () => {
    const actor = current("admin", { owner: true });
    state.replay = 99;
    const identity = {
      id: 7,
      expectedVersion: 1,
      clientRequestId: "owner-replay-visible",
    };
    expect((await approveFulfillmentCharge(identity, actor)).externalCost).toBe(
      "3000.00",
    );
    await expect(
      settleFulfillmentChargePayee(
        {
          ...identity,
          amount: "750",
          tender: { method: "CASH", cashBucket: "DRAWER", shiftId: 1 },
        },
        actor,
      ),
    ).resolves.toEqual({ receiptId: 99 });
  });
  it.each(["cashier", "manager"])(
    "blocks blind completion of outsourced charges with externalCost > 0, including replay, for %s",
    async (role) => {
      const actor = current(role, { policy: hiddenPolicy });
      state.replay = 99;
      await expect(
        completeFulfillmentCharge(
          {
            id: 7,
            expectedVersion: 3,
            clientRequestId: "replay-complete-blind",
            evidence: "إثبات تنفيذ خارجي",
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(state.tx!.insert).not.toHaveBeenCalled();
      expect(state.tx!.update).not.toHaveBeenCalled();
    },
  );
  it("blocks cashier direct TREASURY cash collection even when charges.collect is granted", async () => {
    const actor = current("cashier", { policy: hiddenPolicy });
    await expect(
      collectFulfillmentCharges(
        {
          branchId: 1,
          clientRequestId: "cashier-treasury-collect-denied",
          allocations: [{ chargeId: 7, expectedVersion: 3, amount: "1000" }],
          amount: "1000",
          tender: { method: "CASH", cashBucket: "TREASURY" },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.tx!.insert).not.toHaveBeenCalled();
  });
});
