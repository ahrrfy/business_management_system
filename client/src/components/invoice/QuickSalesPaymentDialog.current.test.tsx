// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinancialIntent } from "@/lib/persistedFinancialIntent";

const state = vi.hoisted(() => ({
  invoice: {} as any, pay: vi.fn(), actor: { id: 7, companyId: null },
  saved: new Map<string, FinancialIntent<unknown>>(), failSave: false,
  invalidate: vi.fn(async () => {}), print: vi.fn(async (_data: unknown) => {}),
  callbacks: { onSuccess: async (_r: unknown) => {}, onError: async (_e: unknown) => {} },
}));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ sales: { get: { fetch: async () => state.invoice, invalidate: state.invalidate }, list: { invalidate: state.invalidate }, listPage: { invalidate: state.invalidate }, listSummary: { invalidate: state.invalidate } } }),
  auth: { me: { useQuery: () => ({ data: state.actor }) } },
  sales: {
    get: { useQuery: () => ({ data: state.invoice, isLoading: false, isFetching: false }) },
    pay: { useMutation: (options: typeof state.callbacks) => { state.callbacks = options; return { mutate: state.pay, isPending: false, isSuccess: false }; } },
    initiateExternalPayment: { useMutation: () => ({ isPending: false }) },
    confirmExternalPayment: { useMutation: () => ({ isPending: false }) },
  },
} }));
vi.mock("@/lib/persistedFinancialIntent", () => ({
  financialIntentScopeKey: (scope: unknown) => JSON.stringify(scope),
  loadFinancialIntent: async (scope: unknown) => state.saved.get(JSON.stringify(scope)) ?? null,
  reserveFinancialIntent: async (scope: unknown, intent: FinancialIntent<unknown>) => { if (state.failSave) throw Error("quota"); const key = JSON.stringify(scope); if (!state.saved.has(key)) state.saved.set(key, structuredClone(intent)); return state.saved.get(key); },
  resolveFinancialIntent: async (scope: unknown, id: string) => { const key = JSON.stringify(scope); if (state.saved.get(key)?.id !== id) return false; state.saved.delete(key); return true; },
  isDefinitiveIntentRejection: (error: unknown) => (error as { data?: { code?: string } })?.data?.code === "BAD_REQUEST",
}));
vi.mock("@/lib/printing/print", () => ({ preopenDocumentWindow: () => null }));
vi.mock("@/lib/printing/cashierLifecycleReceipts", () => ({ printInvoicePaymentReceipt: (data: unknown) => state.print(data) }));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));
vi.mock("@/lib/offline/outbox", () => ({ getDeviceCode: vi.fn() }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ children, onValueChange, ...props }: any) =>
  <select {...props} onChange={event => onValueChange(event.target.value)}>{children}</select>,
}));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: ({ onChange, ariaLabel, ...props }: any) =>
  <input {...props} aria-label={ariaLabel} onChange={event => onChange(event.target.value)} />,
}));

import { QuickSalesPaymentDialog } from "./QuickSalesPaymentDialog";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("quick payment uses the current invoice obligation", () => {
  let host: HTMLDivElement;
  let root: Root;
  const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const remaining = () => [...host.querySelectorAll("span")]
    .find(span => span.textContent === "الرصيد المتبقي:")!.nextElementSibling!.textContent;
  async function render() {
    await act(async () => root.render(<QuickSalesPaymentDialog open onClose={vi.fn()} invoiceId={1}
      invoiceNumber="INV-OLD" remainingAmount="9999" totalAmount="9999" branchId={2} />));
  }
  beforeEach(() => {
    state.invoice = { id: 1, status: "PENDING", total: "100", paidAmount: "0", returnedTotal: "0" };
    state.pay.mockClear();
    state.saved.clear(); state.failSave = false; state.actor = { id: 7, companyId: null };
    state.invalidate.mockReset().mockResolvedValue(undefined); state.print.mockReset().mockResolvedValue(undefined);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it.each(["SUPERSEDED", "CANCELLED", "RETURNED"])("shows no obligation and blocks %s despite retained old total", async status => {
    await render();
    expect(remaining()).toContain("100");
    expect(submit().disabled).toBe(false);
    state.invoice = { ...state.invoice, status };
    await render();
    expect(remaining()).toContain("0");
    expect(remaining()).not.toContain("100");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("لا يمكن تسجيل دفعة");
    expect(submit().disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[aria-label="المبلغ المقبوض"]')!.disabled).toBe(true);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(state.pay).not.toHaveBeenCalled();
  });

  it("updates a live balance when a payment or partial return arrives", async () => {
    await render();
    state.invoice = { ...state.invoice, paidAmount: "30", returnedTotal: "20", status: "PARTIALLY_PAID" };
    await render();
    expect(remaining()).toContain("50");
    expect(host.querySelector<HTMLInputElement>('[aria-label="المبلغ المقبوض"]')!.value).toBe("50.00");
    expect(submit().disabled).toBe(false);
  });

  it("recovers a lost reply using the original command after remount and zero remaining", async () => {
    await render();
    await act(async () => submit().click());
    expect(state.pay).toHaveBeenCalledTimes(1);
    const original = structuredClone(state.pay.mock.calls[0][0]);
    expect(state.saved.size).toBe(1);
    await act(async () => state.callbacks.onError(new Error("Failed to fetch")));
    act(() => root.unmount()); root = createRoot(host);
    state.invoice = { ...state.invoice, status: "PAID", paidAmount: "100" };
    await render();
    expect(submit().textContent).toContain("استرداد"); expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(state.pay.mock.calls[1][0]).toEqual(original);
    await act(async () => state.callbacks.onError({ message: "permission changed", data: { code: "BAD_REQUEST" } }));
    expect(state.saved.size).toBe(1);
  });

  it("persists before transport, blocks double submit and leaves no payment on storage failure", async () => {
    await render(); state.failSave = true;
    await act(async () => submit().click()); expect(state.pay).not.toHaveBeenCalled();
    state.failSave = false;
    await act(async () => { submit().click(); submit().click(); });
    expect(state.pay).toHaveBeenCalledTimes(1); expect(state.saved.size).toBe(1);
  });

  it("does not load another user's intent", async () => {
    await render(); await act(async () => submit().click());
    await act(async () => state.callbacks.onError(new Error("Failed to fetch")));
    state.actor = { id: 8, companyId: null }; await render();
    expect(submit().textContent).not.toContain("استرداد");
    expect(state.saved.size).toBe(1);
  });

  it("settles the durable command before print/refetch failure and prints its captured amounts", async () => {
    await render(); await act(async () => submit().click());
    state.invoice = { ...state.invoice, status: "PAID", paidAmount: "100" }; await render();
    state.print.mockRejectedValueOnce(new Error("printer unavailable"));
    state.invalidate.mockRejectedValue(new Error("refetch failed"));
    await act(async () => state.callbacks.onSuccess({ status: "PAID" }));
    expect(state.saved.size).toBe(0); expect(state.pay).toHaveBeenCalledTimes(1);
    expect(state.print).toHaveBeenCalledWith(expect.objectContaining({ amountPaid: "100.00", paidBefore: "0.00", remainingAfter: "0.00" }));
  });

  it("unlocks a fresh definitively rejected command without losing an unknown prior result", async () => {
    await render(); await act(async () => submit().click());
    await act(async () => state.callbacks.onError({ message: "invalid", data: { code: "BAD_REQUEST" } }));
    expect(state.saved.size).toBe(0);
  });

  it.each(["success", "rejection"])("a late %s from A keeps B's paid-invoice recovery visible", async outcome => {
    await render(); await act(async () => submit().click());
    const callbacksA = state.callbacks;
    const savedA = Array.from(state.saved.values())[0] as FinancialIntent<{ command: { clientRequestId: string } }>;
    const savedB = structuredClone(savedA); savedB.id = "saved-B"; savedB.payload.command.clientRequestId = "saved-B";
    state.saved.set(JSON.stringify({ companyId: null, userId: 8, branchId: 2, operation: "SALES_PAYMENT", target: "invoice:1" }), savedB);
    state.actor = { id: 8, companyId: null };
    state.invoice = { ...state.invoice, status: "PAID", paidAmount: "100" }; await render();
    expect(submit().textContent).toContain("استرداد");
    await act(async () => outcome === "success" ? callbacksA.onSuccess({ status: "PAID" }) : callbacksA.onError({ message: "rejected", data: { code: "BAD_REQUEST" } }));
    expect(submit().textContent).toContain("استرداد"); expect(submit().disabled).toBe(false);
    expect(state.saved.size).toBe(1); expect(state.print).not.toHaveBeenCalled();
    await act(async () => submit().click());
    expect(state.pay.mock.calls[1][0]).toEqual(savedB.payload.command);
  });
});
