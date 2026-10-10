import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";

const state = vi.hoisted(() => ({
  companyId: null as number | null,
  publish: vi.fn(),
  committed: false,
}));
vi.mock("../index", () => ({ publishRealtimeEvent: state.publish }));
vi.mock("../../tenancy/context", () => ({ getCurrentCompanyId: () => state.companyId }));
vi.mock("../../db", () => ({ getDb: () => ({ transaction: async (fn: (tx: Tx) => Promise<unknown>) => {
  const result = await fn({} as Tx);
  state.committed = true;
  return result;
} }) }));
vi.mock("../../services/reports/monthCloseGate", () => ({
  lockFinancialPostingGate: vi.fn(), lockCompanyMonthCloseGate: vi.fn(),
  ensureFinancialPostingGate: vi.fn(), isMonthCloseGateMissing: () => false,
}));
import { withTx } from "../../services/tx";
import { enqueueFinancialRefresh, scheduleFinancialRefresh } from "../financialRefresh";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import { isFinancialMutation } from "@shared/financialRealtime";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CONTROL_DATABASE_URL", "");
  state.companyId = null;
  state.committed = false;
  state.publish.mockReset();
});
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("financial refresh publication", () => {
  it("publishes only after COMMIT and coalesces all entries/branches in a transaction", async () => {
    await withTx(async (tx) => {
      for (let i = 0; i < 100; i++) enqueueFinancialRefresh(tx, i % 2 + 1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(state.committed).toBe(false);
      expect(state.publish).not.toHaveBeenCalled();
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(state.committed).toBe(true);
    expect(state.publish).toHaveBeenCalledExactlyOnceWith(
      REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
      { branchIds: [1, 2] }, { companyId: null, branchId: null },
    );
  });
  it("does not publish a rolled-back financial operation", async () => {
    await expect(withTx(async (tx) => {
      enqueueFinancialRefresh(tx, 4);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.publish).not.toHaveBeenCalled();
  });
  it("isolates companies even when the shared timer was created by another tenant", async () => {
    state.companyId = 11;
    scheduleFinancialRefresh(1);
    state.companyId = 22;
    scheduleFinancialRefresh(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish.mock.calls.map((c) => c[2])).toEqual([
      { companyId: 11, branchId: 1 }, { companyId: 22, branchId: 2 },
    ]);
  });
  it("coalesces a burst and allows a company-wide lifecycle update to supersede branch hints", async () => {
    for (let i = 0; i < 200; i++) scheduleFinancialRefresh(1);
    scheduleFinancialRefresh();
    scheduleFinancialRefresh(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish).toHaveBeenCalledOnce();
    expect(state.publish.mock.calls[0][1]).toEqual({ branchIds: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.publish).toHaveBeenCalledOnce();
  });
  it("fails closed for a tenant-less producer in multi-tenant mode", async () => {
    vi.stubEnv("CONTROL_DATABASE_URL", "mysql://control");
    scheduleFinancialRefresh();
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish).not.toHaveBeenCalled();
  });
  it("includes financial lifecycle and payroll changes without triggering for unrelated mutations", () => {
    for (const path of ["treasury.reassignHandoverReceipt", "shifts.open", "accounts.createManualJournal", "hrEnterprise.approveContract", "attendance.correct", "leaves.approve", "offline.sync"])
      expect(isFinancialMutation(path)).toBe(true);
    for (const path of ["auth.login", "productStudio.generate", "conversations.send", "push.subscribe"])
      expect(isFinancialMutation(path)).toBe(false);
  });
});
