import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import type { OperationPolicy, OperationRecordScope } from "@shared/operationPermissions";

const state = vi.hoisted(() => ({ tx: null as Tx | null, cashLock: vi.fn(), postEntry: vi.fn() }));
vi.mock("../tx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../tx")>(),
  withTx: async (fn: (tx: Tx) => Promise<unknown>) => fn(state.tx!),
}));
vi.mock("../cash/cashAvailability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../cash/cashAvailability")>(),
  lockCashSourceForUpdate: state.cashLock,
  assertCashTransferAvailable: async () => ({ availableBefore: "200.00", availableAfter: "150.00" }),
}));
vi.mock("../ledgerService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ledgerService")>(), postEntry: state.postEntry,
}));

import { storedOperationUser } from "../authorization/operationAuthority";
import { cashHandoverRecipientAllowed, workOrderAssigneeAllowed } from "../authorization/operationRecipientEligibility";
import { assertOperatorOwns, assertWorkOrderBranch } from "../workOrder/helpers";
import { claimWorkOrder, startWorkOrder, markWorkOrderReady, reassignWorkOrder, releaseWorkOrder } from "../workOrder/lifecycle";
import { createWorkOrderInTx } from "../workOrder/create";
import { setWorkOrderKanbanState } from "../workOrder/kanbanState";
import { createCashDrop } from "../cashDropService";
import { acceptPendingTreasuryReceipt, reassignPendingTreasuryReceipt } from "../treasury/pendingReceipts";

const actor: Actor = { userId: 4, role: "warehouse", branchId: 3 };
const executionPaths = ["workOrders.start", "workOrders.markReady", "workOrders.setKanbanState"] as const;
const execute = {
  "workOrders.start": () => startWorkOrder(42, actor),
  "workOrders.markReady": () => markWorkOrderReady(42, actor),
  "workOrders.setKanbanState": () => setWorkOrderKanbanState({ workOrderId: 42, kanbanState: "NORMAL" }, actor),
};

function policy(paths: string[] = [], scope?: OperationRecordScope): OperationPolicy {
  return {
    version: 1, grants: Object.fromEntries(paths.map((path) => [`operation.${path}`, true])),
    ...(scope ? { recordScopes: Object.fromEntries(paths.filter((path) => executionPaths.includes(path as never)).map((path) => [`operation.${path}`, scope])) } : {}),
  };
}

function revokedAcceptance(): OperationPolicy {
  return { version: 1, grants: { "operation.treasury.acceptHandoverReceipt": false } };
}

function account(id = 4, operationPolicy: OperationPolicy | null = policy(), role = "warehouse", branchId: number | null = 3) {
  return { id, role, branchId, isActive: true, isOwner: false, customRoleId: null,
    permissionsOverride: null, operationPolicy, accessExpiresAt: null as Date | null };
}

function profileRows(user: ReturnType<typeof account>): unknown[][] {
  return [[{ customRoleId: null }], [user]];
}

function transaction(rows: unknown[][], permitReceipts = false) {
  let offset = 0;
  let receiptId = 100;
  const writes: unknown[] = [];
  const insert = vi.fn(() => ({ values: async (value: unknown) => {
    if (!permitReceipts) throw new Error("Unexpected financial write");
    writes.push(value);
    return [{ insertId: ++receiptId }];
  } }));
  const update = vi.fn(() => { throw new Error("Unexpected financial write"); });
  const select = vi.fn(() => {
    const result = rows[offset++] ?? [];
    const query: Record<string, unknown> = {
      from: () => query, where: () => query, for: () => query, limit: () => query,
      orderBy: () => query, leftJoin: () => query,
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return query;
  });
  const execute = vi.fn(async () => [[{ locked: 1, v: 1 }]]);
  state.tx = { select, insert, update, execute } as unknown as Tx;
  return { select, insert, update, execute, writes };
}

const custody = { id: 42, branchId: 3, referenceNumber: "CD-3-20261012-0001", direction: "IN", paymentMethod: "CASH",
  cashBucket: "TREASURY", approvalStatus: "APPROVED", status: "PENDING", createdBy: 8, amount: "50.00" };

beforeEach(() => { state.cashLock.mockClear(); state.postEntry.mockClear(); });

describe("execution scope and recipient eligibility", () => {
  it.each(["print_operator", "warehouse", "manager"])("applies the same OWN and BRANCH assignment rules to %s", (role) => {
    const executor = { ...actor, role };
    expect(() => assertOperatorOwns({ assignedTo: 9 }, executor, "OWN")).toThrow();
    expect(() => assertOperatorOwns({ assignedTo: 4 }, executor, "OWN")).not.toThrow();
    expect(() => assertOperatorOwns({ assignedTo: 9 }, executor, "BRANCH")).not.toThrow();
    expect(() => assertWorkOrderBranch({ branchId: 8 }, executor)).toThrow();
  });

  it("preserves the existing assignment restrictions for untouched legacy actors", () => {
    expect(() => assertOperatorOwns({ assignedTo: 9 }, { ...actor, role: "print_operator" }, null)).toThrow();
    expect(() => assertOperatorOwns({ assignedTo: 9 }, { ...actor, role: "manager" }, null)).not.toThrow();
  });

  it.each(executionPaths)("rechecks %s before reading the work order or writing stock", async (path) => {
    const tx = transaction(profileRows(account()));
    await expect(execute[path]()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each([
    ["workOrders.claim", () => claimWorkOrder(42, actor)],
    ["workOrders.release", () => releaseWorkOrder(42, actor)],
  ] as const)("rechecks %s before locking or mutating the work order", async (_path, invoke) => {
    const tx = transaction(profileRows(account()));
    await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each(executionPaths)("defaults a granted %s to the assigned operator", async (path) => {
    const user = account(4, policy([path]));
    const tx = transaction([...profileRows(user), ...profileRows(user), [{ id: 42, branchId: 3, assignedTo: 9, status: "CANCELLED" }]]);
    await expect(execute[path]()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each(executionPaths)("lets BRANCH-scoped %s reach business state validation for another assignee", async (path) => {
    const user = account(4, policy([path], "BRANCH"));
    const tx = transaction([...profileRows(user), ...profileRows(user), [{ id: 42, branchId: 3, assignedTo: 9, status: "CANCELLED" }]]);
    await expect(execute[path]()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("keeps BRANCH scope inside the actor's actual branch", async () => {
    const user = account(4, policy(["workOrders.start"], "BRANCH"));
    transaction([...profileRows(user), ...profileRows(user), [{ id: 42, branchId: 8, assignedTo: 9, status: "RECEIVED" }]]);
    await expect(startWorkOrder(42, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires both production transitions and a usable branch for canonical assignees", () => {
    const both = ["workOrders.start", "workOrders.markReady"];
    expect(workOrderAssigneeAllowed(storedOperationUser(account(9, policy(both))), false, 3)).toBe(true);
    expect(workOrderAssigneeAllowed(storedOperationUser(account(9, policy([both[0]!] ))), true, 3)).toBe(false);
    expect(workOrderAssigneeAllowed(storedOperationUser(account(9, policy(both), "warehouse", null)), true, 3)).toBe(false);
    expect(workOrderAssigneeAllowed(storedOperationUser(account(9, policy(both), "warehouse", 8)), true, 3)).toBe(false);
    expect(workOrderAssigneeAllowed(storedOperationUser(account(9, null, "print_operator", null)), true, 3)).toBe(true);
    expect(workOrderAssigneeAllowed(storedOperationUser(account(9, null, "manager")), false, 3)).toBe(false);
  });

  it("honours the receiver's saved custom role and explicit user revocation", () => {
    const role = { baseRole: "warehouse", isActive: true, permissions: {},
      operationPolicy: policy(["treasury.acceptHandoverReceipt"]), atomicPermissions: null };
    const user = { ...account(9, null), customRoleId: 7 };
    expect(cashHandoverRecipientAllowed(storedOperationUser(user, role), false)).toBe(true);
    const revoked = { ...user, operationPolicy: { version: 1 as const, grants: { "operation.treasury.acceptHandoverReceipt": false } } };
    expect(cashHandoverRecipientAllowed(storedOperationUser(revoked, role), true)).toBe(false);
    expect(cashHandoverRecipientAllowed(storedOperationUser(account(9, null, "manager")), true)).toBe(true);
    expect(cashHandoverRecipientAllowed(storedOperationUser(account(9, revokedAcceptance(), "manager")), true)).toBe(false);
  });

  it("permits a delegated non-print-operator assignee on creation before material validation", async () => {
    const target = account(9, policy(["workOrders.start", "workOrders.markReady"]));
    const tx = transaction([...profileRows(target), [target]]);
    await expect(createWorkOrderInTx(state.tx!, {
      branchId: 3, title: "Production order", salePrice: "100.00", assignedTo: 9,
      materials: [{ variantId: 5, baseQuantity: 0 }],
    }, actor)).rejects.toThrow("كميات المواد");
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses assignment if the selected executor lost either required transition", async () => {
    const target = account(9, policy(["workOrders.start"]));
    const tx = transaction([...profileRows(account(4, policy(["workOrders.assign"]))), ...profileRows(target),
      [{ id: 42, branchId: 3, assignedTo: null, status: "RECEIVED" }], [target]]);
    await expect(reassignWorkOrder({ workOrderId: 42, assignedTo: 9 }, actor)).rejects.toThrow("لا يملك هذا الموظف");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("creates a pending cash custody for a delegated receiver without promoting its base role", async () => {
    const receiver = account(9, policy(["treasury.acceptHandoverReceipt"]));
    const tx = transaction([...profileRows(account(4, policy(["shifts.cashDrop"]))), ...profileRows(receiver),
      [{ id: 2, branchId: 3, userId: 4, status: "OPEN", openingBalance: "200.00" }], [receiver], []], true);
    await expect(createCashDrop({ shiftId: 2, amount: "50.00", dropTo: 9 }, actor)).resolves.toMatchObject({
      outReceiptId: 101, inReceiptId: 102, drawerBefore: "200.00", drawerAfter: "150.00",
    });
    expect(tx.writes).toHaveLength(2);
    expect(tx.writes[1]).toMatchObject({ direction: "IN", cashBucket: "TREASURY", status: "PENDING", createdBy: 9 });
    expect(state.postEntry).toHaveBeenCalledOnce();
  });

  it.each([
    ["revoked manager", account(9, revokedAcceptance(), "manager"), "صلاحية قبول"],
    ["other branch", account(9, policy(["treasury.acceptHandoverReceipt"]), "warehouse", 8), "فرع الوردية"],
    ["same person", account(4, policy(["treasury.acceptHandoverReceipt"])), "المستلم نفسه"],
  ] as const)("rejects a %s cash receiver before writing either side", async (_name, receiver, message) => {
    const tx = transaction([...profileRows(account(4, policy(["shifts.cashDrop"]))), ...profileRows(receiver),
      [{ id: 2, branchId: 3, userId: 4, status: "OPEN", openingBalance: "200.00" }], [receiver]]);
    await expect(createCashDrop({ shiftId: 2, amount: "50.00", dropTo: receiver.id }, actor)).rejects.toThrow(message);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("does not retain acceptance after the receiver's permission is revoked", async () => {
    const tx = transaction(profileRows(account()));
    await expect(acceptPendingTreasuryReceipt(42, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.cashLock).not.toHaveBeenCalled();
    expect(tx.select).toHaveBeenCalledTimes(2);
  });

  it("keeps actual custody ownership even when acceptance is granted", async () => {
    const tx = transaction([...profileRows(account(4, policy(["treasury.acceptHandoverReceipt"]))), [{ branchId: 3 }], [custody]]);
    await expect(acceptPendingTreasuryReceipt(42, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rejects reassignment to a manager whose acceptance grant was revoked", async () => {
    const target = account(9, revokedAcceptance(), "manager");
    const tx = transaction([...profileRows(account(4, policy(["treasury.reassignHandoverReceipt"]))), ...profileRows(target), [custody], [target]]);
    await expect(reassignPendingTreasuryReceipt(42, 9, actor)).rejects.toThrow("صلاحية قبول");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("preserves independent cash receipt after delegated reassignment", async () => {
    const target = account(9, policy(["treasury.acceptHandoverReceipt"]));
    const tx = transaction([...profileRows(account(4, policy(["treasury.reassignHandoverReceipt"]))), ...profileRows(target), [custody], [target],
      [{ id: 11, amount: "50.00", createdBy: 9, shiftId: null }],
      [{ receiptId: 11, entryType: "CASH_TRANSFER_OUT", branchId: 3, amount: "50.00" }]]);
    await expect(reassignPendingTreasuryReceipt(42, 9, actor)).rejects.toThrow("مُسلِّم النقد نفسه");
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rejects an expired selected receiver before locking or writing the shift", async () => {
    const target = { ...account(9, policy(["treasury.acceptHandoverReceipt"])), accessExpiresAt: new Date("2001-01-01") };
    const tx = transaction([...profileRows(account(4, policy(["shifts.cashDrop"]))), ...profileRows(target)]);
    await expect(createCashDrop({ shiftId: 2, amount: "50.00", dropTo: 9 }, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(4);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
