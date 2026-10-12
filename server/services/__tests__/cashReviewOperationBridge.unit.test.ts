import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";
import type { Actor } from "../tx";
import type { OperationPolicy } from "@shared/operationPermissions";

const state = vi.hoisted(() => ({ tx: null as Tx | null }));
vi.mock("../tx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../tx")>(),
  withTx: async (fn: (tx: Tx) => Promise<unknown>) => {
    if (!state.tx) throw new Error("Test transaction not configured");
    return fn(state.tx);
  },
}));

import {
  approveCashVarianceCase,
  getCashVarianceCase,
  listCashVarianceCases,
  listCashVarianceResponsibleUsers,
  proposeCashVarianceCase,
  registerCashVarianceEvidence,
  rejectCashVarianceCase,
} from "../cashVarianceService";
import {
  decideMissedDailyCountException,
  requestMissedDailyCountException,
} from "../cash/missedDailyCountException";

const actor: Actor = { userId: 4, role: "warehouse", branchId: 3 };
const audit = { userId: actor.userId, branchId: actor.branchId };
const decision = { caseId: 42, expectedVersion: 1, clientRequestId: "decision-42", note: "Independent reviewer" };
const missedDecision = { exceptionId: 42, expectedVersion: 1, clientRequestId: "missed-decision-42", note: "Independent reviewer", decision: "APPROVED" as const };

const operations: Array<[string, () => Promise<unknown>]> = [
  ["treasury.cashVariance.registerEvidence", () => registerCashVarianceEvidence({
    branchId: 3, fileName: "evidence.pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjcK", clientRequestId: "evidence-42",
  }, actor)],
  ["treasury.cashVariance.propose", () => proposeCashVarianceCase({
    sourceType: "CUSTODY", sourceId: 42, reasonCode: "COUNT_ERROR", reason: "Documented counting difference",
    evidenceDocumentId: 9, evidenceReference: "evidence-9", clientRequestId: "proposal-42",
  }, actor)],
  ["treasury.cashVariance.approve", () => approveCashVarianceCase(decision, actor)],
  ["treasury.cashVariance.reject", () => rejectCashVarianceCase({ ...decision, reason: "Evidence is incomplete" }, actor)],
  ["treasury.cashVariance.list", () => listCashVarianceCases({}, actor)],
  ["treasury.cashVariance.get", () => getCashVarianceCase(42, actor)],
  ["treasury.cashVariance.responsibleUsers", () => listCashVarianceResponsibleUsers(3, actor)],
  ["treasury.missedDailyCount.request", () => requestMissedDailyCountException({
    branchId: 3, businessDate: "2001-01-01", carryForwardReconciliationId: 42,
    reason: "Historical documented missing count", evidenceReference: "evidence-9", clientRequestId: "missed-request-42",
  }, actor, audit)],
  ["treasury.missedDailyCount.decide", () => decideMissedDailyCountException(missedDecision, actor, audit)],
];

function policy(path?: string): OperationPolicy {
  return { version: 1, grants: Object.fromEntries(operations.map(([key]) => [`operation.${key}`, key === path])) };
}

function account(path?: string) {
  return { id: 4, role: "warehouse", branchId: 3, isActive: true, isOwner: false, customRoleId: null,
    permissionsOverride: null, operationPolicy: policy(path) };
}

function transaction(rows: unknown[][]) {
  let offset = 0;
  const insert = vi.fn(() => { throw new Error("Unexpected financial write"); });
  const update = vi.fn(() => { throw new Error("Unexpected financial write"); });
  const select = vi.fn(() => {
    const result = rows[offset++] ?? [];
    const query: Record<string, unknown> = {
      from: () => query, where: () => query, for: () => query, limit: () => query,
      orderBy: () => query, innerJoin: () => query, groupBy: () => query, as: () => query,
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return query;
  });
  state.tx = { select, insert, update } as unknown as Tx;
  return { select, insert, update };
}

function freshTransaction(path?: string, businessRows: unknown[][] = []) {
  return transaction([[{ customRoleId: null }], [account(path)], ...businessRows]);
}

describe("cash review operation bridges", () => {
  it.each(operations)("blocks %s on authoritative denial before reading or writing financial records", async (_path, execute) => {
    const tx = freshTransaction();
    await expect(execute()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("allows a delegated warehouse reviewer to read its branch without a manager role", async () => {
    freshTransaction("treasury.cashVariance.get", [[{
      id: 42, branchId: 3, proposedByUserId: 1, countedByUserId: 2, responsibleUserId: null,
    }], [{ eventType: "PROPOSED", version: 1 }]]);
    await expect(getCashVarianceCase(42, actor)).resolves.toMatchObject({ id: 42, status: "PROPOSED", version: 1 });
  });

  it("does not let a read grant authorize an approval", async () => {
    const tx = freshTransaction("treasury.cashVariance.get");
    await expect(approveCashVarianceCase(decision, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("retains branch isolation after delegation", async () => {
    freshTransaction("treasury.cashVariance.get", [[{ id: 42, branchId: 8 }]]);
    await expect(getCashVarianceCase(42, actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("retains maker-checker decision guidance after delegation", async () => {
    freshTransaction("treasury.cashVariance.get", [[{
      id: 42, branchId: 3, proposedByUserId: 4, countedByUserId: 2, responsibleUserId: null,
    }], [{ eventType: "PROPOSED", version: 1 }]]);
    await expect(getCashVarianceCase(42, actor)).resolves.toMatchObject({ decisionPolicy: { canDecide: false } });
  });

  it("lets a granted approval reach business validation without raw manager-role rejection", async () => {
    freshTransaction("treasury.cashVariance.approve", [[]]);
    await expect(approveCashVarianceCase(decision, actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("still prevents a delegated user from deciding its own missed-count request", async () => {
    const tx = freshTransaction("treasury.missedDailyCount.decide", [
      [{ branchId: 3 }], [], [{ id: 42, branchId: 3, requestedByUserId: 4, status: "PENDING", version: 1 }],
    ]);
    await expect(decideMissedDailyCountException(missedDecision, actor, audit)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("does not retain legacy manager access after an explicit canonical revocation", async () => {
    const current = { ...account(), role: "manager" };
    const tx = transaction([[{ customRoleId: null }], [current]]);
    await expect(getCashVarianceCase(42, { ...actor, role: "manager" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.select).toHaveBeenCalledTimes(2);
  });
});
