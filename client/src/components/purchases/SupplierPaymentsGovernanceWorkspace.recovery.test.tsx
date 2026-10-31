// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinancialIntent } from "@/lib/persistedFinancialIntent";

const state = vi.hoisted(() => ({
  saved: new Map<string, FinancialIntent<unknown>>(),
  failSave: false,
  actor: { id: 7, companyId: null },
  payment: vi.fn(async (_input: unknown) => ({ requestId: 9 })),
  refund: vi.fn(async (_input: unknown) => ({ requestId: 10 })),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: { me: { useQuery: () => ({ data: state.actor }) } },
    supplierPayments: {
      cashSources: {
        useQuery: () => ({ data: { canUseTreasury: true, drawers: [] } }),
      },
      pendingPayments: { useQuery: () => ({ data: [] }) },
      pendingRefunds: { useInfiniteQuery: () => ({ data: { pages: [] } }) },
    },
  },
}));
vi.mock("@/lib/lifecycleOperationAccess", () => ({
  canLifecycleOperation: () => true,
}));
vi.mock("@/lib/notify", () => ({ notify: { err: vi.fn() } }));
vi.mock("@/lib/persistedFinancialIntent", () => ({
  financialIntentScopeKey: (scope: unknown) => JSON.stringify(scope),
  loadFinancialIntent: async (scope: unknown) =>
    state.saved.get(JSON.stringify(scope)) ?? null,
  reserveFinancialIntent: async (
    scope: unknown,
    intent: FinancialIntent<unknown>,
  ) => {
    if (state.failSave) throw Error("quota");
    const key = JSON.stringify(scope);
    if (!state.saved.has(key)) state.saved.set(key, structuredClone(intent));
    return state.saved.get(key);
  },
  resolveFinancialIntent: async (scope: unknown, id: string) => {
    const key = JSON.stringify(scope);
    if (state.saved.get(key)?.id !== id) return false;
    state.saved.delete(key);
    return true;
  },
  isDefinitiveIntentRejection: () => false,
}));
vi.mock("./GovernanceApprovalQueue", () => ({
  GovernanceApprovalQueue: () => null,
}));
vi.mock("@/components/ui/dialog", () => ({
  useDialogComposition: () => ({
    justEndedComposing: () => false,
    setComposing: () => {},
    markCompositionEnd: () => {},
  }),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({
    children,
    onValueChange,
    ...props
  }: React.SelectHTMLAttributes<HTMLSelectElement> & {
    onValueChange: (value: string) => void;
  }) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
}));
vi.mock("@/components/form/MoneyInput", () => ({
  MoneyInput: ({
    onChange,
    ariaLabel,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
    onChange: (value: string) => void;
    ariaLabel?: string;
  }) => (
    <input
      {...props}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
import { SupplierPaymentsGovernanceWorkspace } from "./SupplierPaymentsGovernanceWorkspace";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
type Props = React.ComponentProps<typeof SupplierPaymentsGovernanceWorkspace>;
const scope = {
  companyId: null,
  userId: 7,
  branchId: 2,
  operation: "SUPPLIER_SETTLEMENT",
  target: "workspace",
};
describe("supplier request durable recovery", () => {
  let host: HTMLDivElement, root: Root, props: Props;
  beforeEach(() => {
    state.saved.clear();
    state.failSave = false;
    state.actor = { id: 7, companyId: null };
    state.payment.mockReset().mockResolvedValue({ requestId: 9 });
    state.refund.mockReset().mockResolvedValue({ requestId: 10 });
    props = {
      branchId: 2,
      paymentSources: [],
      refundSources: [],
      pendingPayments: [],
      pendingRefunds: [],
      currentUserId: 7,
      isOwner: true,
      canDecide: true,
      decisionBlockedReason: "",
      loadingSources: false,
      onRetrySources: vi.fn(),
      paymentSourcesHasMore: false,
      refundSourcesHasMore: false,
      loadingMoreSources: false,
      onLoadMorePaymentSources: vi.fn(),
      onLoadMoreRefundSources: vi.fn(),
      requestPending: false,
      decisionPending: false,
      onRequestPayment: state.payment,
      onRequestRefund: state.refund,
      onDecidePayment: vi.fn(),
      onDecideRefund: vi.fn(),
      pendingPaymentLoading: false,
      pendingRefundLoading: false,
      onRetryPendingPayments: vi.fn(),
      onRetryPendingRefunds: vi.fn(),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = async () => {
    await act(async () =>
      root.render(<SupplierPaymentsGovernanceWorkspace {...props} />),
    );
  };
  const button = (text: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    )!;
  async function fill(id: string, value: string) {
    const element = host.querySelector<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >(id)!;
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(
        new Event(element instanceof HTMLSelectElement ? "change" : "input", {
          bubbles: true,
        }),
      );
    });
  }
  it.each(["PAYMENT", "REFUND"] as const)(
    "recovers exact %s with no remaining eligible source and survives remount",
    async (mode) => {
      const input =
        mode === "PAYMENT"
          ? {
              requestKey: "original-payment",
              branchId: 2,
              supplierId: 3,
              allocations: [
                { supplierInvoiceId: 8, invoiceVersion: 4, amount: "1000.00" },
              ],
            }
          : {
              requestKey: "original-refund",
              supplierPaymentId: 9,
              expectedPaymentVersion: 2,
              allocations: [
                { supplierPaymentAllocationId: 6, amount: "1000.00" },
              ],
            };
      state.saved.set(JSON.stringify(scope), {
        id: input.requestKey,
        createdAt: new Date().toISOString(),
        payload: { mode, input },
      });
      const callback = mode === "PAYMENT" ? state.payment : state.refund;
      callback.mockRejectedValueOnce(new Error("Failed to fetch"));
      await render();
      await act(async () => {
        button("استرداد طلب المورد السابق").click();
        button("استرداد طلب المورد السابق").click();
      });
      expect(callback).toHaveBeenCalledExactlyOnceWith(input);
      expect(state.saved.size).toBe(1);
      act(() => root.unmount());
      root = createRoot(host);
      await render();
      await act(async () => button("استرداد طلب المورد السابق").click());
      expect(callback.mock.calls[1][0]).toEqual(input);
      expect(state.saved.size).toBe(0);
    },
  );
  it("saves a fresh complete request before transport, refuses storage failure, and restores its original version", async () => {
    props.paymentSources = [
      {
        supplierInvoiceId: 8,
        invoiceNumber: "SI-8",
        invoiceVersion: 4,
        supplierId: 3,
        supplierLabel: "Lab supplier",
        currency: "IQD",
        exchangeRate: null,
        remainingAmount: "1000.00",
        remainingCurrencyAmount: "1000.00",
      },
    ];
    await render();
    await act(async () => button("طلب سداد").click());
    await fill("#supplier-payment-group", "3:IQD");
    await fill("#payment-iqd-8", "1000");
    await fill("#supplier-payment-reference", "bank-test");
    await fill("#supplier-payment-evidence", "proof-test");
    await fill("#supplier-payment-reason", "isolated lab request");
    expect(button("إرسال للاعتماد").disabled).toBe(false);
    state.failSave = true;
    await act(async () => button("إرسال للاعتماد").click());
    expect(state.payment).not.toHaveBeenCalled();
    state.failSave = false;
    state.payment.mockRejectedValueOnce(new Error("Failed to fetch"));
    await act(async () => button("إرسال للاعتماد").click());
    expect(state.payment).toHaveBeenCalledTimes(1);
    const original = structuredClone(state.payment.mock.calls[0][0]);
    expect(state.saved.size).toBe(1);
    act(() => root.unmount());
    root = createRoot(host);
    props.paymentSources = [];
    await render();
    await act(async () => button("استرداد طلب المورد السابق").click());
    expect(state.payment.mock.calls[1][0]).toEqual(original);
    expect(state.saved.size).toBe(0);
  });
});
