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
vi.mock("../../services/auditService", async importOriginal => ({
  ...await importOriginal<typeof import("../../services/auditService")>(),
  withMutationAuditScope: async <T>(work: () => Promise<T>) => ({ value: await work(), specializedAuditWritten: true }),
  logAudit: vi.fn(),
}));
import { withTx } from "../../services/tx";
import { publicProcedure, router } from "../../trpc";
import type { TrpcContext } from "../../context";
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
  it.each([false, true])("retains company-wide fallback for composite inventory mutations (ledger hint: %s)", async hinted => {
    const api = router({ inventory: router({ transferReceive: publicProcedure.mutation(async () => {
      if (hinted) await withTx(async tx => enqueueFinancialRefresh(tx, 1));
      return { ok: true };
    }) }) }).createCaller({ user: { id: 2, role: "cashier", isOwner: false, branchId: 2 },
      req: { headers: {} }, res: {}, nativeClientId: null } as unknown as TrpcContext);
    await api.inventory.transferReceive();
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish).toHaveBeenCalledExactlyOnceWith(REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
      { branchIds: null }, { companyId: null, branchId: null });
  });
  it("keeps concurrent mutation hints isolated and publishes nothing for a rolled back return", async () => {
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const routes = router({ returns: router({ create: publicProcedure.mutation(async ({ ctx }) => {
      if (ctx.user!.id === 1) {
        started();
        await paused;
      } else await withTx(async tx => enqueueFinancialRefresh(tx, 2));
      return { mode: "EXECUTED" };
    }), executeSalesReturnCart: publicProcedure.mutation(async () => {
      await withTx(async tx => { enqueueFinancialRefresh(tx, 3); throw new Error("rollback"); });
    }) }) });
    const caller = (id: number, branchId: number) => routes.createCaller({
      user: { id, role: "cashier", isOwner: false, branchId }, req: { headers: {} }, res: {}, nativeClientId: null,
    } as unknown as TrpcContext);
    const first = caller(1, 1).returns.create();
    await ready;
    await caller(2, 2).returns.create();
    resume();
    await first;
    await expect(caller(3, 3).returns.executeSalesReturnCart()).rejects.toThrow("rollback");
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish).toHaveBeenCalledExactlyOnceWith(REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
      { branchIds: [2, 1] }, { companyId: null, branchId: null });
  });
  it("preserves the committed branch through a branch-bound return mutation's audit middleware", async () => {
    const api = router({ returns: router({ create: publicProcedure.mutation(async () => {
      await withTx(async tx => enqueueFinancialRefresh(tx, 2));
      return { mode: "EXECUTED" };
    }) }) }).createCaller({ user: { id: 2, role: "cashier", isOwner: false, branchId: 2 },
      req: { headers: {} }, res: {}, nativeClientId: null } as unknown as TrpcContext);
    await api.returns.create();
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish).toHaveBeenCalledExactlyOnceWith(REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
      { branchIds: [2] }, { companyId: null, branchId: 2 });
  });
  it("retains a company-wide fallback when an owner cart may affect invoice and stock in different branches", async () => {
    const api = router({ returns: router({ executeSalesReturnCart: publicProcedure.mutation(async () => {
      await withTx(async tx => enqueueFinancialRefresh(tx, 1));
      return { ok: true };
    }) }) }).createCaller({ user: { id: 1, role: "admin", isOwner: true, branchId: 1 },
      req: { headers: {} }, res: {}, nativeClientId: null } as unknown as TrpcContext);
    await api.returns.executeSalesReturnCart();
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish).toHaveBeenCalledExactlyOnceWith(REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
      { branchIds: null }, { companyId: null, branchId: null });
  });
  it("scopes a successful cashier lifecycle fallback to that cashier's branch", async () => {
    const api = router({ returns: router({ create: publicProcedure.mutation(() => ({ mode: "EXECUTED" })) }) })
      .createCaller({ user: { id: 2, role: "cashier", isOwner: false, branchId: 2 },
        req: { headers: {} }, res: {}, nativeClientId: null } as unknown as TrpcContext);
    await api.returns.create();
    await vi.advanceTimersByTimeAsync(400);
    expect(state.publish).toHaveBeenCalledExactlyOnceWith(REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
      { branchIds: [2] }, { companyId: null, branchId: 2 });
  });
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
    for (const path of ["treasury.reassignHandoverReceipt", "shifts.open", "accounts.createManualJournal", "hrEnterprise.approveContract", "attendance.correct", "leaves.approve", "offline.sync", "returns.create", "returns.executeSalesReturnCart", "inventory.adjust", "storeAdmin.orders.dispatch", "storefront.cancelOrderByToken"])
      expect(isFinancialMutation(path)).toBe(true);
    for (const path of ["auth.login", "productStudio.generate", "conversations.send", "push.subscribe", "storefront.trackOrderByToken", "storefront.trackOrderPrivate"])
      expect(isFinancialMutation(path)).toBe(false);
  });
});
