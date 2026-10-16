// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ invoice: {} as any, pay: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ sales: { get: { fetch: async () => state.invoice } } }),
  sales: {
    get: { useQuery: () => ({ data: state.invoice, isLoading: false, isFetching: false }) },
    pay: { useMutation: () => ({ mutate: state.pay, isPending: false, isSuccess: false }) },
    initiateExternalPayment: { useMutation: () => ({ isPending: false }) },
    confirmExternalPayment: { useMutation: () => ({ isPending: false }) },
  },
} }));
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
});
