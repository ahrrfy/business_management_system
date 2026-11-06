// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinancialIntent, FinancialIntentScope } from "@/lib/persistedFinancialIntent";
const state = vi.hoisted(() => ({
  saved: new Map<string, FinancialIntent<unknown>>(), failSave: false, losePrepare: false, loseFinalize: false,
  intents: new Map<string, number>(), invoices: new Map<number, number>(), status: "EXECUTED", refunded: false,
  prepare: vi.fn(), finalize: vi.fn(), initiate: vi.fn(), confirm: vi.fn(), read: vi.fn(), completed: vi.fn(), prepared: vi.fn(), onRefunded: vi.fn(),
}));
vi.mock("@/lib/offline/outbox", () => ({ getDeviceCode: async () => "reception-device-1" }));
vi.mock("@/lib/persistedFinancialIntent", () => ({
  financialIntentScopeKey: (scope: unknown) => JSON.stringify(scope),
  loadFinancialIntent: async (scope: unknown) => state.saved.get(JSON.stringify(scope)) ?? null,
  reserveFinancialIntent: async (scope: unknown, envelope: FinancialIntent<unknown>) => {
    if (state.failSave) throw Error("quota");
    const key = JSON.stringify(scope); if (!state.saved.has(key)) state.saved.set(key, structuredClone(envelope)); return state.saved.get(key);
  },
  resolveFinancialIntent: async (scope: unknown, id: string) => { const key = JSON.stringify(scope); if (state.saved.get(key)?.id !== id) return false; state.saved.delete(key); return true; },
}));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ digitalCards: { sales: { getIntent: { fetch: state.read } } } }),
  digitalCards: { sales: { prepare: { useMutation: () => ({ mutateAsync: state.prepare }) }, finalize: { useMutation: () => ({ mutateAsync: state.finalize }) } } },
  reception: { initiateExternalPayment: { useMutation: () => ({ mutateAsync: state.initiate }) }, confirmExternalPayment: { useMutation: () => ({ mutateAsync: state.confirm }) } },
} }));
import { useReceptionDigitalCheckout, type ReceptionDigitalCommand } from "./useReceptionDigitalCheckout";
const scope: FinancialIntentScope = { companyId: null, userId: 7, branchId: 1, operation: "DIGITAL_RECEPTION", target: "workspace" };
const candidate = (request = "original", method: "CASH" | "CARD" = "CARD"): Omit<ReceptionDigitalCommand, "version" | "deviceId"> => ({
  prepare: { clientRequestId: request, branchId: 1, shiftId: 5, paymentMethod: method, cartFingerprint: request,
    sourceType: "RECEPTION", sourcePayload: { version: 1, cashRoundIQD: false }, customerId: 10,
    lines: [{ lineKey: "card", offeringId: 1, priceVersionId: 2, expectedSellPrice: "250000.00", providerReference: "001172" }] },
  amount: "250000.00", captureConfirmed: true, reference: method === "CARD" ? "10324087" : null, customerName: "العميل الأصلي",
});
let api: ReturnType<typeof useReceptionDigitalCheckout>;
let root: Root; let element: HTMLDivElement;
function Harness({ currentScope = scope }: { currentScope?: FinancialIntentScope }) {
  api = useReceptionDigitalCheckout({ scope: currentScope, onPrepared: state.prepared, onCompleted: state.completed, onRefunded: state.onRefunded }); return null;
}
async function mount() { element = document.createElement("div"); document.body.append(element); root = createRoot(element); await act(async () => { root.render(<Harness />); }); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks(); state.saved.clear(); state.intents.clear(); state.invoices.clear();
  state.failSave = false; state.losePrepare = false; state.loseFinalize = false; state.status = "EXECUTED"; state.refunded = false;
  state.initiate.mockResolvedValue({ attemptId: 44, state: "CONFIRMED" }); state.confirm.mockResolvedValue({ attemptId: 44 });
  state.prepare.mockImplementation(async (input: { clientRequestId: string }) => {
    if (!state.intents.has(input.clientRequestId)) state.intents.set(input.clientRequestId, 9);
    if (state.losePrepare) { state.losePrepare = false; throw Error("lost prepare response"); }
    return { intentId: state.intents.get(input.clientRequestId) };
  });
  state.finalize.mockImplementation(async (input: { intentId: number }) => {
    if (!state.invoices.has(input.intentId)) state.invoices.set(input.intentId, 55);
    if (state.loseFinalize) { state.loseFinalize = false; throw Error("lost finalize response"); }
    return { intentId: input.intentId, invoiceId: 55, invoiceNumber: "ONE", total: "250000.00", paymentMethod: "CARD", paidAmount: "250000.00" };
  });
  state.read.mockImplementation(async () => ({ intent: { id: 9, status: state.refunded ? "CANCELLED" : state.invoices.size ? "FINALIZED" : state.status },
    financialSettlement: state.refunded ? { status: "COMPLETED", saleAmount: "0.00", refundAmount: "250000.00" } : null }));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); element?.remove(); vi.unstubAllGlobals(); });
describe("durable digital reception command", () => {
  it("stops before any server operation if durable storage fails", async () => {
    await mount(); state.failSave = true;
    await act(async () => { await expect(api.start(candidate())).rejects.toThrow("quota"); });
    expect(state.initiate).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled(); expect(state.finalize).not.toHaveBeenCalled();
  });
  it("recovers lost responses with the original method, customer, reference and keys after reload", async () => {
    await mount(); state.losePrepare = true;
    await act(async () => { await expect(api.start(candidate())).rejects.toThrow("lost prepare response"); });
    await act(async () => root.unmount()); element.remove(); await mount();
    await act(async () => { await api.start(candidate("new-cart", "CASH")); });
    expect(state.prepare.mock.calls[1][0]).toMatchObject({ clientRequestId: "original", paymentMethod: "CARD", customerId: 10, externalPaymentAttemptId: 44, externalPaymentDeviceId: "reception-device-1" });
    expect(state.prepare.mock.calls[1][0].capturedDigitalPayment).toEqual({ confirmed:true,amount:"250000.00",deviceId:"reception-device-1" });
    expect(state.initiate.mock.calls.every(([call]) => call.reference === "10324087" && call.requestId === "original:card")).toBe(true);
    state.loseFinalize = true;
    await act(async () => { await expect(api.finalizePrepared(9)).rejects.toThrow("lost finalize response"); });
    await act(async () => { await api.retry(); });
    expect(state.intents.size).toBe(1); expect(state.invoices.size).toBe(1); expect(state.completed).toHaveBeenCalledTimes(1);
    expect(state.finalize.mock.calls.every(([call]) => call.clientRequestId === "original" && call.paymentMethod === "CARD" && call.paymentAmount === "250000.00")).toBe(true);
    expect(state.saved.size).toBe(0);
  });
  it("retains unknown/review work without finalization or a replacement issue", async () => {
    await mount(); state.status = "NEEDS_REVIEW";
    await act(async () => { await expect(api.start(candidate())).rejects.toThrow(/مراجعة/); });
    expect(state.saved.size).toBe(1); expect(state.prepared).not.toHaveBeenCalled(); expect(state.finalize).not.toHaveBeenCalled();
  });
  it("keeps an envelope after reload until the exact captured amount is resolved", async () => {
    await mount(); state.status="NEEDS_REVIEW";
    await act(async()=>{await expect(api.start(candidate())).rejects.toThrow(/مراجعة/);});
    await act(async()=>root.unmount()); element.remove(); await mount();
    state.read.mockResolvedValueOnce({intent:{id:9,status:"CANCELLED"},financialSettlement:{status:"COMPLETED",saleAmount:"0.00",refundAmount:"200000.00"}});
    await act(async()=>{await expect(api.retry()).rejects.toThrow(/مراجعة/);});
    expect(state.saved.size).toBe(1); expect(state.finalize).not.toHaveBeenCalled();
    state.refunded=true; await act(async()=>{await api.retry();});
    expect(state.saved.size).toBe(0); expect(state.onRefunded).toHaveBeenCalledOnce();
  });
  it("clears only after the server proves the original full refund completed", async () => {
    await mount(); state.refunded = true;
    await act(async () => { await api.start(candidate()); });
    expect(state.saved.size).toBe(0); expect(state.onRefunded).toHaveBeenCalledWith("250000.00"); expect(state.finalize).not.toHaveBeenCalled();
  });
});
